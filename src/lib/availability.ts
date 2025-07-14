import { eq, and, sql } from 'drizzle-orm';
import { db } from './db';
import { units, bookings, blackouts } from './schema';
import { getConfig } from './config';
import jwt from 'jsonwebtoken';

/* ---------- return shape ---------- */
export interface BucketRemaining {
  bucket: string; // '[2025-07-01 09:30,2025-07-01 10:00)'
  unit_id: number;
  remaining_capacity: number;
}

/* ---------- prepared statement ---------- */
const remainingSql = (winStart: Date, winEnd: Date) => sql/*sql*/ `
WITH params AS (
  SELECT
    ${winStart}::timestamptz AS win_start,
    ${winEnd}::timestamptz AS win_end
),                /* … copy the full SQL from section 1 … */

/* 1. snap the window to the previous :00 / :30 ------------------------*/
aligned AS (
  SELECT
    to_timestamp(floor(extract(epoch FROM win_start) / 1800) * 1800)
        AT TIME ZONE 'UTC' AS aligned_start,
    win_end
  FROM params
),

/* 2. emit half-hour buckets ------------------------------------------*/
buckets AS (
  SELECT
    tstzrange(gs,
              gs + INTERVAL '30 minutes',
              '[)')                 AS bucket
  FROM aligned a
  CROSS JOIN LATERAL generate_series(
      a.aligned_start,
      a.win_end - INTERVAL '30 minutes',
      INTERVAL '30 minutes') AS gs
),

usable_buckets AS (
  SELECT b.bucket, u.unit_id, u.capacity
  FROM   buckets b
  CROSS  JOIN units u
  LEFT   JOIN blackouts bo
           ON bo.unit_id = u.unit_id
          AND bo.period && b.bucket
  WHERE  bo.blackout_id IS NULL
    AND  u.active = TRUE
),
booking_counts AS (
  SELECT
    ub.bucket,
    ub.unit_id,
    COUNT(bk.booking_id) AS overlap_count,
    ub.capacity
  FROM   usable_buckets  ub
  LEFT   JOIN bookings bk
           ON bk.unit_id = ub.unit_id
          AND bk.slot && ub.bucket
          AND bk.status = 'confirmed'
  GROUP  BY ub.bucket, ub.unit_id, ub.capacity
)
SELECT
  bucket::text                    AS bucket,
  unit_id,
  capacity        - overlap_count AS remaining_capacity
FROM booking_counts
WHERE capacity - overlap_count > 0
ORDER BY bucket, unit_id;
`;

// Note: Drizzle doesn't have a prepare method, we'll use the query directly

/* ---------- runtime wrapper ---------- */
export async function remainingCapacityByHalfHour(
  winStart: Date,
  winEnd: Date
): Promise<BucketRemaining[]> {
  const result = await db.execute(remainingSql(winStart, winEnd));
  return result.rows as unknown as BucketRemaining[];
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface AvailableSlot {
  slot: TimeRange;
  unitId: number;
  price: number;
  signature: string; // Individual signature per slot
}

export interface SignedAvailability {
  data: AvailableSlot[];
}

export class SaunaAvailabilityManager {
  private config = getConfig();

  private parseTstzRange(rangeStr: string): TimeRange {
    const match = rangeStr.match(/\["([^"]+)","([^"]+)"\)/);
    if (!match) {
      throw new Error(`Invalid tstzrange format: ${rangeStr}`);
    }

    return {
      start: new Date(match[1]),
      end: new Date(match[2]),
    };
  }

  private timeRangeToTstzRange(range: TimeRange): string {
    return `[${range.start.toISOString()}, ${range.end.toISOString()})`;
  }

  private calculatePrice(slot: TimeRange, unitId: number): number {
    return 700;
    const basePrice = 3000; // $30 in cents
    const hour = slot.start.getHours();
    const isPeakHour = hour >= 18 && hour < 21;

    return isPeakHour ? Math.floor(basePrice * 1.5) : basePrice;
  }

  /**
   * Sign an individual slot with price and unit info
   */
  private signSlot(slot: TimeRange, unitId: number, price: number): string {
    return jwt.sign(
      {
        type: 'slot_availability',
        slot: {
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
        },
        unitId,
        price,
        timestamp: Date.now(),
        exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 minutes expiry
      },
      this.config.jwt.secret
    );
  }

  /**
   * Find available slots using the efficient bucket query
   */
  async availableSlots(start: Date, stop: Date): Promise<SignedAvailability> {
    const capacityData = await remainingCapacityByHalfHour(start, stop);
    const availableSlots: AvailableSlot[] = [];

    for (const row of capacityData) {
      if (row.remaining_capacity > 0) {
        const slot = this.parseTstzRange(row.bucket);

        // Skip slots in the past
        if (slot.start <= new Date()) continue;

        const price = this.calculatePrice(slot, row.unit_id);
        const signature = this.signSlot(slot, row.unit_id, price);

        availableSlots.push({
          slot,
          unitId: row.unit_id,
          price,
          signature,
        });
      }
    }

    return { data: availableSlots };
  }

  /**
   * Verify an individual slot signature
   */
  verifySlotSignature(slotData: AvailableSlot): boolean {
    try {
      const decoded = jwt.verify(slotData.signature, this.config.jwt.secret) as any;

      return (
        decoded.type === 'slot_availability' &&
        decoded.slot.start === slotData.slot.start.toISOString() &&
        decoded.slot.end === slotData.slot.end.toISOString() &&
        decoded.unitId === slotData.unitId &&
        decoded.price === slotData.price &&
        decoded.exp > Math.floor(Date.now() / 1000)
      );
    } catch {
      return false;
    }
  }

  /**
   * Book a slot using a signed slot object
   */
  async bookSlot(userId: number, signedSlot: AvailableSlot): Promise<boolean> {
    // Verify the signature first
    if (!this.verifySlotSignature(signedSlot)) {
      throw new Error('Invalid or expired slot signature');
    }

    console.log('booking...');

    return await db.transaction(async tx => {
      // Verify unit exists and is active
      const unit = await tx.query.units.findFirst({
        where: and(eq(units.unitId, signedSlot.unitId), eq(units.active, true)),
      });

      console.log(unit);

      if (!unit) {
        throw new Error('Unit not found or inactive');
      }

      // Double-check capacity for this specific slot
      const slotStart = new Date(signedSlot.slot.start);
      const slotEnd = new Date(signedSlot.slot.end);
      const capacityCheck = await remainingCapacityByHalfHour(slotStart, slotEnd);

      const availableForUnit = capacityCheck.find(
        c =>
          c.unit_id === signedSlot.unitId &&
          this.parseTstzRange(c.bucket).start.getTime() === signedSlot.slot.start.getTime()
      );

      if (!availableForUnit || availableForUnit.remaining_capacity <= 0) {
        console.log('too bad');
        throw new Error('Slot no longer available');
      }

      // Create the booking
      const [booking] = await tx
        .insert(bookings)
        .values({
          userId,
          unitId: signedSlot.unitId,
          slot: this.timeRangeToTstzRange(signedSlot.slot),
          status: 'confirmed',
        })
        .returning();

      console.log(booking);

      return !!booking;
    });
  }

  /**
   * Get user's upcoming bookings
   */
  async getUserBookings(userId: number): Promise<any[]> {
    return await db.query.bookings.findMany({
      where: and(
        eq(bookings.userId, userId),
        eq(bookings.status, 'confirmed'),
        sql`upper(slot) > now()`
      ),
      with: {
        unit: true,
      },
      orderBy: sql`lower(slot)`,
    });
  }

  /**
   * Get user's bookings that overlap with a specific time range
   */
  async getUserBookingsInRange(userId: number, start: Date, stop: Date): Promise<any[]> {
    return await db.query.bookings.findMany({
      where: and(
        eq(bookings.userId, userId),
        eq(bookings.status, 'confirmed'),
        sql`slot && tstzrange(${start.toISOString()}, ${stop.toISOString()}, '[)')`
      ),
      orderBy: sql`lower(slot)`,
    });
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(bookingId: number, userId: number): Promise<boolean> {
    const result = await db
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(bookings.bookingId, bookingId),
          eq(bookings.userId, userId),
          eq(bookings.status, 'confirmed')
        )
      )
      .execute();

    return result.rowCount != null && result.rowCount > 0;
  }
}
