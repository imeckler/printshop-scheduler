import { and, eq, isNull, sql } from 'drizzle-orm';
import moment from 'moment-timezone';
import { RRule, rrulestr, Weekday } from 'rrule';
import { db } from './db';
import { events, eventTimeslots, eventPermissions, lockActivations, units, users } from './schema';
import { BookingMessage } from './websocketTypes';

// Default timezone for recurrence expansion and display. Matches the
// hardcoded display timezone used elsewhere (index.ts helpers, booking.tsx).
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

// How far ahead recurring events are materialized into event_timeslots.
export const MATERIALIZATION_HORIZON_DAYS = 90;

// How early before a timeslot starts a user may activate the lock.
export const ACTIVATION_GRACE_MINUTES = 15;

// Printshop bookings are only allowed between these wall-clock hours
// (in DEFAULT_TIMEZONE) on a single day.
export const BOOKING_OPEN_HOUR = 6; // 6:00 AM
export const BOOKING_CLOSE_HOUR = 22; // 10:00 PM

// SQL predicate: user row alias `u` currently has effective access — their
// authorizer has granted them AND the authorizer itself is still valid
// (e.g. still holds the Discord role). Requires `authorizers a` joined on
// u.authorizer_id.
export const hasAccessSql = sql`u.authorized AND a.valid`;

// Global reference to broadcast function (set by main server)
let globalBroadcastFunction: ((message: BookingMessage) => void) | null = null;

export function setBroadcastFunction(broadcastFn: (message: BookingMessage) => void) {
  globalBroadcastFunction = broadcastFn;
}

function broadcast(message: BookingMessage) {
  if (globalBroadcastFunction) {
    globalBroadcastFunction(message);
  }
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export function parseTstzRange(rangeStr: string): TimeRange {
  const match = rangeStr.match(/\["?([^",]+)"?,"?([^",)]+)"?\)/);
  if (!match) {
    throw new Error(`Invalid tstzrange format: ${rangeStr}`);
  }
  return {
    start: new Date(match[1]),
    end: new Date(match[2]),
  };
}

export function timeRangeToTstzRange(range: TimeRange): string {
  return `[${range.start.toISOString()}, ${range.end.toISOString()})`;
}

/* ------------------------------------------------------------------ */
/* Recurrence expansion                                               */
/* ------------------------------------------------------------------ */

// rrule with a TZID DTSTART yields occurrence Dates whose UTC fields hold the
// *wall clock* time in the rule's timezone ("fake UTC"). These helpers map
// between fake-UTC and real instants, which is what makes expansion DST-safe.
function fakeUtcToInstant(fake: Date, timezone: string): Date {
  return moment
    .tz(
      [
        fake.getUTCFullYear(),
        fake.getUTCMonth(),
        fake.getUTCDate(),
        fake.getUTCHours(),
        fake.getUTCMinutes(),
        fake.getUTCSeconds(),
      ],
      timezone
    )
    .toDate();
}

function instantToFakeUtc(instant: Date, timezone: string): Date {
  const m = moment.tz(instant, timezone);
  return new Date(Date.UTC(m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second()));
}

export function expandRrule(
  rruleStr: string,
  timezone: string,
  durationMinutes: number,
  windowStart: Date,
  windowEnd: Date
): TimeRange[] {
  const rule = rrulestr(rruleStr);
  // Widen the fake-UTC window by a day on each side, then filter on real
  // instants, so timezone offset shifts at the window edges can't drop or
  // duplicate occurrences.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const fakeStart = new Date(instantToFakeUtc(windowStart, timezone).getTime() - DAY_MS);
  const fakeEnd = new Date(instantToFakeUtc(windowEnd, timezone).getTime() + DAY_MS);

  return rule
    .between(fakeStart, fakeEnd, true)
    .map(fake => {
      const start = fakeUtcToInstant(fake, timezone);
      return { start, end: new Date(start.getTime() + durationMinutes * 60 * 1000) };
    })
    .filter(r => r.start >= windowStart && r.start < windowEnd);
}

// Interpret a local wall-clock date + time in the given timezone as an instant.
export function localDateTimeToInstant(date: string, time: string, timezone: string): Date {
  const m = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', true, timezone);
  if (!m.isValid()) {
    throw new Error(`Invalid date/time: ${date} ${time}`);
  }
  return m.toDate();
}

// A structured recurrence spec (as produced by the admin form), turned into an
// RRULE string + duration. Weekday follows the RRule convention: 0=Monday.
export interface RecurrenceSpec {
  freq: 'weekly' | 'monthly';
  interval: number;
  weekday: number;
  monthlyMode?: 'nth' | 'last'; // monthly only
  nth?: number; // monthly 'nth' mode: 1..5
  startDate: string; // YYYY-MM-DD, first day the rule can fire
  startTime: string; // HH:MM wall clock
  endTime: string; // HH:MM wall clock
  ends: 'never' | 'until' | 'count';
  untilDate?: string; // YYYY-MM-DD inclusive
  count?: number;
  timezone?: string;
}

export function buildRecurrence(spec: RecurrenceSpec): {
  rrule: string;
  durationMinutes: number;
  timezone: string;
} {
  const timezone = spec.timezone ?? DEFAULT_TIMEZONE;

  const [startH, startM] = spec.startTime.split(':').map(Number);
  const [endH, endM] = spec.endTime.split(':').map(Number);
  if ([startH, startM, endH, endM].some(isNaN)) {
    throw new Error('Invalid start/end time');
  }
  const durationMinutes = endH * 60 + endM - (startH * 60 + startM);
  if (durationMinutes <= 0) {
    throw new Error('End time must be after start time');
  }

  if (spec.weekday < 0 || spec.weekday > 6) {
    throw new Error('Invalid weekday');
  }
  let byweekday: Weekday | number = spec.weekday;
  if (spec.freq === 'monthly') {
    if (spec.monthlyMode === 'last') {
      byweekday = new Weekday(spec.weekday, -1);
    } else {
      const nth = spec.nth ?? 1;
      if (nth < 1 || nth > 5) {
        throw new Error('Invalid nth-of-month value');
      }
      byweekday = new Weekday(spec.weekday, nth);
    }
  }

  const [y, mo, d] = spec.startDate.split('-').map(Number);
  if ([y, mo, d].some(isNaN)) {
    throw new Error('Invalid start date');
  }
  // rrule dtstart/until are "fake UTC": UTC fields hold the local wall clock.
  const dtstart = new Date(Date.UTC(y, mo - 1, d, startH, startM, 0));

  let until: Date | undefined;
  if (spec.ends === 'until') {
    if (!spec.untilDate) throw new Error('Missing end date');
    const [uy, um, ud] = spec.untilDate.split('-').map(Number);
    if ([uy, um, ud].some(isNaN)) throw new Error('Invalid end date');
    until = new Date(Date.UTC(uy, um - 1, ud, 23, 59, 59));
  }

  const rule = new RRule({
    freq: spec.freq === 'weekly' ? RRule.WEEKLY : RRule.MONTHLY,
    interval: spec.interval > 0 ? spec.interval : 1,
    byweekday,
    dtstart,
    until,
    count: spec.ends === 'count' ? spec.count : undefined,
    tzid: timezone,
  });

  return { rrule: rule.toString(), durationMinutes, timezone };
}

// Human-readable summary of an event's schedule, for admin listings.
export function describeSchedule(event: {
  kind: string;
  rrule: string | null;
  timezone: string | null;
}): string {
  if (event.kind !== 'recurring' || !event.rrule) {
    return 'Fixed timeslots';
  }
  try {
    return rrulestr(event.rrule).toText();
  } catch {
    return event.rrule;
  }
}

/* ------------------------------------------------------------------ */
/* Density (per-unit concurrent attendee counts)                      */
/* ------------------------------------------------------------------ */

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

// Interval sweep: given attendee-slots overlapping [start, end], produce the
// piecewise-constant concurrency profile over that window.
function sweepDensity(slots: TimeRange[], start: Date, end: Date): BookingDensityInterval[] {
  const countAtStart = slots.reduce((acc, s) => (s.start <= start ? acc + 1 : acc), 0);

  const changePoints: Map<number, { starts: number; ends: number }> = new Map();
  const bump = (t: number, key: 'starts' | 'ends') => {
    const r = changePoints.get(t) ?? { starts: 0, ends: 0 };
    r[key] += 1;
    changePoints.set(t, r);
  };
  slots.forEach(s => {
    if (start < s.start && s.start <= end) bump(s.start.getTime(), 'starts');
    if (s.end < end && s.end >= start) bump(s.end.getTime(), 'ends');
  });

  const changes = Array.from(changePoints.entries()).sort((c1, c2) => c1[0] - c2[0]);

  const intervals: BookingDensityInterval[] = [];
  let count = countAtStart;
  for (let i = 0; i < changes.length + 1; ++i) {
    intervals.push({
      startTime: i === 0 ? start : new Date(changes[i - 1][0]),
      endTime: i === changes.length ? end : new Date(changes[i][0]),
      bookedCount: count,
    });
    if (i < changes.length) {
      const [, { starts, ends }] = changes[i];
      count += starts - ends;
    }
  }
  return intervals;
}

// One row per (permitted user, confirmed timeslot) of active events on the
// unit, overlapping the range — i.e. one row per prospective attendee-slot.
async function attendeeSlotsForUnit(
  tx: typeof db,
  unitId: number,
  start: Date,
  end: Date
): Promise<TimeRange[]> {
  const result = await tx.execute(sql`
    SELECT ts.slot::text AS slot
    FROM event_timeslots ts
    JOIN events e ON e.event_id = ts.event_id
    JOIN event_permissions p ON p.event_id = e.event_id
    WHERE e.unit_id = ${unitId}
      AND e.status = 'active'
      AND ts.status = 'confirmed'
      AND ts.slot && tstzrange(${start.toISOString()}, ${end.toISOString()}, '[)')
  `);
  return (result.rows as Array<{ slot: string }>).map(r => parseTstzRange(r.slot));
}

export async function getUnitDensity(
  unitId: number,
  start: Date,
  end: Date
): Promise<BookingDensityResponse> {
  const unit = await db.query.units.findFirst({
    where: and(eq(units.unitId, unitId), eq(units.active, true)),
  });
  if (!unit) {
    throw new Error('Unit not found or inactive');
  }

  const slots = await attendeeSlotsForUnit(db, unitId, start, end);
  return {
    intervals: sweepDensity(slots, start, end),
    totalCapacity: unit.capacity,
    requestedRange: { start, end },
  };
}

/* ------------------------------------------------------------------ */
/* Event creation                                                     */
/* ------------------------------------------------------------------ */

export interface CreateEventOptions {
  name: string;
  description?: string;
  createdBy?: number;
  unitId?: number;
  kind: 'finite' | 'recurring';
  slots?: TimeRange[]; // finite events
  rrule?: string; // recurring events: full iCal string incl. DTSTART;TZID=...
  durationMinutes?: number;
  timezone?: string;
  permittedUserIds: number[];
}

export interface CreatedEvent {
  eventId: number;
  timeslotIds: number[];
}

export async function createEvent(opts: CreateEventOptions): Promise<CreatedEvent> {
  if (opts.kind === 'finite') {
    if (!opts.slots || opts.slots.length === 0) {
      throw new Error('A finite event needs at least one timeslot');
    }
    for (const s of opts.slots) {
      if (s.end <= s.start) {
        throw new Error('Timeslot end must be after start');
      }
    }
  } else {
    if (!opts.rrule || !opts.durationMinutes || opts.durationMinutes <= 0) {
      throw new Error('A recurring event needs an rrule and a positive duration');
    }
  }

  return await db.transaction(async tx => {
    const [event] = await tx
      .insert(events)
      .values({
        name: opts.name,
        description: opts.description,
        createdBy: opts.createdBy,
        unitId: opts.unitId,
        kind: opts.kind,
        rrule: opts.kind === 'recurring' ? opts.rrule : null,
        durationMinutes: opts.kind === 'recurring' ? opts.durationMinutes : null,
        timezone: opts.kind === 'recurring' ? (opts.timezone ?? DEFAULT_TIMEZONE) : null,
        status: 'active',
      })
      .returning();

    let slots: TimeRange[];
    let generated: boolean;
    if (opts.kind === 'finite') {
      slots = opts.slots!;
      generated = false;
    } else {
      const now = new Date();
      const horizon = new Date(now.getTime() + MATERIALIZATION_HORIZON_DAYS * 24 * 60 * 60 * 1000);
      // Look back one occurrence-length so an occurrence already in progress
      // at creation time is materialized too (and can be activated).
      const windowStart = new Date(now.getTime() - opts.durationMinutes! * 60 * 1000);
      slots = expandRrule(
        opts.rrule!,
        opts.timezone ?? DEFAULT_TIMEZONE,
        opts.durationMinutes!,
        windowStart,
        horizon
      );
      generated = true;
    }

    let timeslotIds: number[] = [];
    if (slots.length > 0) {
      const inserted = await tx
        .insert(eventTimeslots)
        .values(
          slots.map(s => ({
            eventId: event.eventId,
            slot: timeRangeToTstzRange(s),
            generated,
            status: 'confirmed',
          }))
        )
        .returning({ timeslotId: eventTimeslots.timeslotId });
      timeslotIds = inserted.map(r => r.timeslotId);
    }

    if (opts.permittedUserIds.length > 0) {
      await tx
        .insert(eventPermissions)
        .values(opts.permittedUserIds.map(userId => ({ userId, eventId: event.eventId })))
        .onConflictDoNothing();
    }

    return { eventId: event.eventId, timeslotIds };
  });
}

/* ------------------------------------------------------------------ */
/* Printshop booking (single-timeslot self-permissioned event)        */
/* ------------------------------------------------------------------ */

export async function bookPrintshopSlot(
  userId: number,
  unitId: number,
  start: Date,
  end: Date
): Promise<{ eventId: number }> {
  if (end <= start) {
    throw new Error('End time must be after start time');
  }

  // Bookings must fall entirely within open hours on a single day (shop time).
  const startLocal = moment.tz(start, DEFAULT_TIMEZONE);
  const endLocal = moment.tz(end, DEFAULT_TIMEZONE);
  const openTime = startLocal.clone().startOf('day').hour(BOOKING_OPEN_HOUR);
  const closeTime = startLocal.clone().startOf('day').hour(BOOKING_CLOSE_HOUR);
  if (startLocal.isBefore(openTime) || endLocal.isAfter(closeTime)) {
    throw new Error('Bookings are only available between 6:00 AM and 10:00 PM');
  }

  return await db.transaction(async tx => {
    // Serialize capacity checks per unit so concurrent bookings can't both
    // pass the check and overshoot capacity.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${unitId})`);

    const unit = await tx.query.units.findFirst({
      where: and(eq(units.unitId, unitId), eq(units.active, true)),
    });
    if (!unit) {
      throw new Error('Unit not found or inactive');
    }

    const existing = await attendeeSlotsForUnit(tx as unknown as typeof db, unitId, start, end);
    const maxConcurrent = Math.max(
      0,
      ...sweepDensity(existing, start, end).map(i => i.bookedCount)
    );
    if (maxConcurrent >= unit.capacity) {
      throw new Error('This time range is fully booked');
    }

    const [event] = await tx
      .insert(events)
      .values({
        name: 'Printshop booking',
        createdBy: userId,
        unitId,
        kind: 'finite',
        status: 'active',
      })
      .returning();

    await tx.insert(eventTimeslots).values({
      eventId: event.eventId,
      slot: timeRangeToTstzRange({ start, end }),
      generated: false,
      status: 'confirmed',
    });

    await tx.insert(eventPermissions).values({ userId, eventId: event.eventId });

    return { eventId: event.eventId };
  });
}

/* ------------------------------------------------------------------ */
/* Lock activation                                                    */
/* ------------------------------------------------------------------ */

export interface ActivatableSlot {
  timeslotId: number;
  eventId: number;
  eventName: string;
  slot: TimeRange;
  activated: boolean;
  accessStop: Date;
}

// The confirmed, active-event timeslot the user is permissioned on whose
// window (with early grace) contains `now` — or null. Prefers the slot that
// ends latest so back-to-back slots activate for the longest window.
export async function getActivatableSlot(
  userId: number,
  now: Date = new Date()
): Promise<ActivatableSlot | null> {
  const result = await db.execute(sql`
    SELECT ts.timeslot_id AS "timeslotId",
           e.event_id AS "eventId",
           e.name AS "eventName",
           ts.slot::text AS slot,
           la.user_id IS NOT NULL AS activated
    FROM event_timeslots ts
    JOIN events e ON e.event_id = ts.event_id
    JOIN event_permissions p ON p.event_id = e.event_id AND p.user_id = ${userId}
    JOIN users u ON u.user_id = p.user_id
    JOIN authorizers a ON a.authorizer_id = u.authorizer_id
    LEFT JOIN lock_activations la
           ON la.timeslot_id = ts.timeslot_id AND la.user_id = ${userId} AND la.revoked_at IS NULL
    WHERE ${hasAccessSql}
      AND e.status = 'active'
      AND ts.status = 'confirmed'
      AND ${now.toISOString()}::timestamptz >= lower(ts.slot) - make_interval(mins => ${ACTIVATION_GRACE_MINUTES})
      AND ${now.toISOString()}::timestamptz < upper(ts.slot)
    ORDER BY upper(ts.slot) DESC
    LIMIT 1
  `);

  const row = result.rows[0] as
    | { timeslotId: number; eventId: number; eventName: string; slot: string; activated: boolean }
    | undefined;
  if (!row) return null;

  const slot = parseTstzRange(row.slot);
  return {
    timeslotId: Number(row.timeslotId),
    eventId: Number(row.eventId),
    eventName: row.eventName,
    slot,
    activated: row.activated,
    accessStop: slot.end,
  };
}

export type ActivateLockResult =
  | { ok: true; code: string; until: Date }
  | { ok: false; error: string };

// The only path that puts a code on the lock. Idempotent: re-activating an
// already-activated slot rebroadcasts the stored window (the daemon treats an
// identical addAccess as a no-op).
export async function activateLock(
  userId: number,
  now: Date = new Date()
): Promise<ActivateLockResult> {
  const candidate = await getActivatableSlot(userId, now);
  if (!candidate) {
    return { ok: false, error: 'You have no event happening right now' };
  }

  const user = await db.query.users.findFirst({
    where: eq(users.userId, userId),
    columns: { code: true },
  });
  if (!user?.code) {
    return { ok: false, error: 'No door code on file for your account' };
  }

  // Append-only insert. The partial unique index (one unrevoked row per
  // user+timeslot) makes a double-tap a no-op, while re-activation after a
  // revocation inserts a fresh history row. The stored access window must be
  // broadcast verbatim: the daemon removes intervals by exact
  // (code, start, stop) match.
  const inserted = await db.execute(sql`
    INSERT INTO lock_activations (user_id, timeslot_id, access_start, access_stop)
    VALUES (${userId}, ${candidate.timeslotId}, ${now.toISOString()}::timestamptz, ${candidate.slot.end.toISOString()}::timestamptz)
    ON CONFLICT (user_id, timeslot_id) WHERE revoked_at IS NULL DO NOTHING
    RETURNING access_start AS "accessStart", access_stop AS "accessStop"
  `);

  let accessStart: Date;
  let accessStop: Date;
  if (inserted.rows.length > 0) {
    const row = inserted.rows[0] as { accessStart: Date; accessStop: Date };
    accessStart = new Date(row.accessStart);
    accessStop = new Date(row.accessStop);
  } else {
    // A live activation already exists: rebroadcast its stored window.
    const existing = await db.query.lockActivations.findFirst({
      where: and(
        eq(lockActivations.userId, userId),
        eq(lockActivations.timeslotId, candidate.timeslotId),
        isNull(lockActivations.revokedAt)
      ),
    });
    if (!existing) {
      return { ok: false, error: 'Could not activate the lock, please try again' };
    }
    accessStart = existing.accessStart;
    accessStop = existing.accessStop;
  }

  broadcast({
    kind: 'addAccess',
    code: user.code,
    start: accessStart.getTime(),
    stop: accessStop.getTime(),
  });

  return { ok: true, code: user.code, until: accessStop };
}

// Broadcast removeAccess for any still-relevant activations matching the
// given filter, and mark them revoked. Activation rows are never deleted —
// they are a permanent attendance log. Returns the number revoked.
async function revokeActivations(
  where: ReturnType<typeof sql>,
  now: Date = new Date()
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE lock_activations la
    SET revoked_at = ${now.toISOString()}::timestamptz
    FROM users u, event_timeslots ts
    WHERE u.user_id = la.user_id
      AND ts.timeslot_id = la.timeslot_id
      AND la.revoked_at IS NULL
      AND la.access_stop > ${now.toISOString()}::timestamptz
      AND ${where}
    RETURNING u.code, la.access_start AS "accessStart", la.access_stop AS "accessStop"
  `);

  for (const row of result.rows as Array<{ code: string; accessStart: Date; accessStop: Date }>) {
    broadcast({
      kind: 'removeAccess',
      code: row.code,
      start: new Date(row.accessStart).getTime(),
      stop: new Date(row.accessStop).getTime(),
    });
  }
  return result.rows.length;
}

/* ------------------------------------------------------------------ */
/* Cancellation                                                       */
/* ------------------------------------------------------------------ */

export async function cancelEvent(
  eventId: number,
  opts: { requireCreatorUserId?: number } = {}
): Promise<boolean> {
  const event = await db.query.events.findFirst({
    where: and(eq(events.eventId, eventId), eq(events.status, 'active')),
  });
  if (!event) return false;
  if (opts.requireCreatorUserId !== undefined && event.createdBy !== opts.requireCreatorUserId) {
    return false;
  }

  await db.update(events).set({ status: 'cancelled' }).where(eq(events.eventId, eventId));
  await revokeActivations(sql`ts.event_id = ${eventId}`);
  return true;
}

export async function cancelOccurrence(timeslotId: number): Promise<boolean> {
  const result = await db
    .update(eventTimeslots)
    .set({ status: 'cancelled' })
    .where(and(eq(eventTimeslots.timeslotId, timeslotId), eq(eventTimeslots.status, 'confirmed')))
    .execute();
  if (!result.rowCount) return false;

  await revokeActivations(sql`ts.timeslot_id = ${timeslotId}`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                        */
/* ------------------------------------------------------------------ */

export async function addPermission(eventId: number, userId: number): Promise<void> {
  await db.insert(eventPermissions).values({ eventId, userId }).onConflictDoNothing();
}

export async function removePermission(eventId: number, userId: number): Promise<void> {
  await db
    .delete(eventPermissions)
    .where(and(eq(eventPermissions.eventId, eventId), eq(eventPermissions.userId, userId)));
  await revokeActivations(sql`ts.event_id = ${eventId} AND la.user_id = ${userId}`);
}

/* ------------------------------------------------------------------ */
/* Queries for views                                                  */
/* ------------------------------------------------------------------ */

export interface UserOccurrence {
  timeslotId: number;
  eventId: number;
  eventName: string;
  createdBy: number | null;
  slot: string; // raw tstzrange text, for the formatSlot helper
  slotRange: TimeRange;
}

// A user's authorization was revoked (or their authorizer changed/removed):
// pull their code off the lock for anything still live.
export async function revokeActivationsForUser(
  userId: number,
  now: Date = new Date()
): Promise<number> {
  return revokeActivations(sql`la.user_id = ${userId}`, now);
}

// An authorizer became invalid (lost their Discord role, was deleted):
// pull every dependent user's code off the lock.
export async function revokeActivationsForAuthorizer(
  authorizerId: number,
  now: Date = new Date()
): Promise<number> {
  return revokeActivations(sql`u.authorizer_id = ${authorizerId}`, now);
}

export async function getUserOccurrences(
  userId: number,
  opts: { futureOnly?: boolean } = { futureOnly: true }
): Promise<UserOccurrence[]> {
  const result = await db.execute(sql`
    SELECT ts.timeslot_id AS "timeslotId",
           e.event_id AS "eventId",
           e.name AS "eventName",
           e.created_by AS "createdBy",
           ts.slot::text AS slot
    FROM event_timeslots ts
    JOIN events e ON e.event_id = ts.event_id
    JOIN event_permissions p ON p.event_id = e.event_id AND p.user_id = ${userId}
    WHERE e.status = 'active'
      AND ts.status = 'confirmed'
      ${opts.futureOnly === false ? sql`` : sql`AND upper(ts.slot) > now()`}
    ORDER BY lower(ts.slot)
  `);

  return (
    result.rows as Array<{
      timeslotId: number;
      eventId: number;
      eventName: string;
      createdBy: number | null;
      slot: string;
    }>
  ).map(r => ({
    timeslotId: Number(r.timeslotId),
    eventId: Number(r.eventId),
    eventName: r.eventName,
    createdBy: r.createdBy === null ? null : Number(r.createdBy),
    slot: r.slot,
    slotRange: parseTstzRange(r.slot),
  }));
}

// Currently-activated access windows, for WS replay when the daemon
// reconnects. Replayed with the stored timestamps (idempotent daemon-side).
export async function getActiveAccessWindows(
  now: Date = new Date()
): Promise<Array<{ code: string; start: number; stop: number }>> {
  const result = await db.execute(sql`
    SELECT u.code, la.access_start AS "accessStart", la.access_stop AS "accessStop"
    FROM lock_activations la
    JOIN users u ON u.user_id = la.user_id
    JOIN authorizers a ON a.authorizer_id = u.authorizer_id
    JOIN event_timeslots ts ON ts.timeslot_id = la.timeslot_id
    JOIN events e ON e.event_id = ts.event_id
    WHERE la.access_stop > ${now.toISOString()}::timestamptz
      AND la.revoked_at IS NULL
      AND ${hasAccessSql}
      AND e.status = 'active'
      AND ts.status = 'confirmed'
  `);

  return (result.rows as Array<{ code: string; accessStart: Date; accessStop: Date }>).map(r => ({
    code: r.code,
    start: new Date(r.accessStart).getTime(),
    stop: new Date(r.accessStop).getTime(),
  }));
}

/* ------------------------------------------------------------------ */
/* Materialization                                                    */
/* ------------------------------------------------------------------ */

// Expand active recurring events out to the horizon. Idempotent: the unique
// index on (event_id, lower(slot)) makes re-runs no-ops, and cancelled
// occurrences survive because we never delete-and-regenerate.
export async function materializeRecurringEvents(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + MATERIALIZATION_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const recurring = await db.query.events.findMany({
    where: and(eq(events.kind, 'recurring'), eq(events.status, 'active')),
  });

  let insertedCount = 0;
  for (const event of recurring) {
    if (!event.rrule || !event.durationMinutes) continue;
    // Look back one occurrence-length so in-progress occurrences are covered
    // (the unique index makes re-inserting already-known slots a no-op).
    const windowStart = new Date(now.getTime() - event.durationMinutes * 60 * 1000);
    const slots = expandRrule(
      event.rrule,
      event.timezone ?? DEFAULT_TIMEZONE,
      event.durationMinutes,
      windowStart,
      horizon
    );
    for (const s of slots) {
      const result = await db.execute(sql`
        INSERT INTO event_timeslots (event_id, slot, generated, status)
        VALUES (${event.eventId}, ${timeRangeToTstzRange(s)}::tstzrange, true, 'confirmed')
        ON CONFLICT (event_id, lower(slot)) DO NOTHING
      `);
      insertedCount += result.rowCount ?? 0;
    }
  }

  // Note: lock_activations rows are intentionally never cleaned up — they
  // are a permanent record of who activated the lock for which occurrence.

  return insertedCount;
}

export function startMaterializationTimer(): void {
  materializeRecurringEvents().catch(err =>
    console.error('Initial recurring-event materialization failed:', err)
  );
  setInterval(
    () => {
      materializeRecurringEvents().catch(err =>
        console.error('Recurring-event materialization failed:', err)
      );
    },
    24 * 60 * 60 * 1000
  );
}
