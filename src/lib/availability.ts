import { eq, and, sql } from 'drizzle-orm';
import { db } from './db';
import { units, bookings, blackouts, users } from './schema';
import { getConfig } from './config';
import jwt from 'jsonwebtoken';
import { BookingMessage } from './websocketTypes';

// Global reference to broadcast function (will be set by main server)
let globalBroadcastFunction: ((message: BookingMessage) => void) | null = null;

export function setBroadcastFunction(broadcastFn: (message: BookingMessage) => void) {
  globalBroadcastFunction = broadcastFn;
}

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

export interface BookingDensityInterval {
  startTime: Date;
  endTime: Date;
  bookedCount: number;
}

export interface BookingDensityResponse {
  intervals: BookingDensityInterval[];
  totalCapacity: number;
  requestedRange: TimeRange;
}

export class AvailabilityManager {
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
    return 0;
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

      // Get user code for WebSocket message
      if (booking && globalBroadcastFunction) {
        const user = await tx.query.users.findFirst({
          where: eq(users.userId, userId),
          columns: { code: true }
        });
        
        if (user?.code) {
          globalBroadcastFunction({
            kind: 'addAccess',
            code: user.code,
            start: signedSlot.slot.start.getTime(),
            stop: signedSlot.slot.end.getTime()
          });
        }
      }

      return !!booking;
    });
  }

  /**
   * Get user's upcoming bookings
   */
  async getUserBookings(userId: number): Promise<any[]> {
    const test = await db.query.bookings.findMany({
      where: and(
        eq(bookings.userId, userId),
        eq(bookings.status, 'confirmed'),
      ),
      with: {
        unit: true,
      },
      orderBy: sql`lower(slot)`,
    });
    console.log('f', test);
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

  async getBookingDensity(unitId: number, start: Date, end: Date): Promise<BookingDensityResponse> {
    const overlappingBookings: Array<{slot: string}> = await db.query.bookings.findMany({
      where: and(
        eq(bookings.unitId, unitId),
        eq(bookings.status, 'confirmed'),
        sql`slot && tstzrange(${start.toISOString()}, ${end.toISOString()}, '[)')`
      ),
      orderBy: sql`lower(slot)`,
    });

    const unit = await db.query.units.findFirst({
      where: and(eq(units.unitId, unitId), eq(units.active, true)),
    });
    if (!unit) {
      throw new Error('Unit not found or inactive');
    }

    const slots = overlappingBookings.map((b) => this.parseTstzRange(b.slot));
    console.log('overlapping bookings', overlappingBookings);
    console.log('overlapping slots', slots);
    console.log('me start', start);
    const numBookingsAtStart = slots.reduce(((acc, b) => b.start <= start ? acc + 1 : acc), 0);
    console.log('at astart', numBookingsAtStart);

    const changePoints: Map<number, {starts: number, ends: number}> = new Map();
    slots.forEach((s) => {
      if (start < s.start && s.start <= end) {
        const t = s.start.getTime();
        const r = changePoints.get(t);
        if (r != undefined) {
          r.starts += 1;
        } else {
          changePoints.set(t, { starts: 1, ends: 0 });
        }
      }

      if (s.end < end && s.end >= start) {
        const t = s.end.getTime();
        const r = changePoints.get(t);
        if (r != undefined) {
          r.ends += 1;
        } else {
          changePoints.set(t, { starts: 0, ends: 1 });
        }
      }
    });

    const changes = Array.from(changePoints.entries());
    changes.sort((c1, c2) => c1[0] - c2[0]);

    const intervals: Array<BookingDensityInterval> = [];

    let numBookings = numBookingsAtStart;

    for (let i = 0; i < changes.length + 1; ++i) {
      const startTime = i == 0 ? start : new Date(changes[i - 1][0]);
      const endTime = i == changes.length ? end : new Date(changes[i][0]);

      intervals.push({
        startTime,
        endTime,
        bookedCount: numBookings,
      });

      if (i < changes.length) {
        const [_, { starts, ends }] = changes[i];
        numBookings += starts;
        numBookings -= ends;
      }
    }

    return { intervals, totalCapacity: unit.capacity, requestedRange: { start, end } };
  }

  /**
   * Book a custom time range
   */
  async bookCustomTimeRange(userId: number, start: Date, end: Date, unitId: number): Promise<boolean> {
    return await db.transaction(async tx => {
      // Verify unit exists and is active
      const unit = await tx.query.units.findFirst({
        where: and(eq(units.unitId, unitId), eq(units.active, true)),
      });

      if (!unit) {
        throw new Error('Unit not found or inactive');
      }

      console.log('sloot',
          this.timeRangeToTstzRange({ start, end }));
      // Create the booking with custom time range
      const [booking] = await tx
        .insert(bookings)
        .values({
          userId,
          unitId: unitId,
          slot: this.timeRangeToTstzRange({ start, end }),
          status: 'confirmed',
        })
        .returning();

      // Get user code for WebSocket message
      if (booking && globalBroadcastFunction) {
        const user = await tx.query.users.findFirst({
          where: eq(users.userId, userId),
          columns: { code: true }
        });
        
        if (user?.code) {
          globalBroadcastFunction({
            kind: 'addAccess',
            code: user.code,
            start: start.getTime(),
            stop: end.getTime()
          });
        }
      }

      return !!booking;
    });
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(bookingId: number, userId: number): Promise<boolean> {
    return await db.transaction(async tx => {
      // Get booking details before cancelling
      const booking = await tx.query.bookings.findFirst({
        where: and(
          eq(bookings.bookingId, bookingId),
          eq(bookings.userId, userId),
          eq(bookings.status, 'confirmed')
        ),
        with: {
          user: {
            columns: { code: true }
          }
        }
      });

      if (!booking) {
        return false;
      }

      const result = await tx
        .update(bookings)
        .set({ status: 'cancelled' })
        .where(eq(bookings.bookingId, bookingId))
        .execute();

      // Send WebSocket message for cancelled booking
      if (result.rowCount && result.rowCount > 0 && globalBroadcastFunction && booking.user?.code) {
        const slotData = this.parseTstzRange(booking.slot);
        globalBroadcastFunction({
          kind: 'removeAccess',
          code: booking.user.code,
          start: slotData.start.getTime(),
          stop: slotData.end.getTime()
        });
      }

      return result.rowCount != null && result.rowCount > 0;
    });
  }
}
