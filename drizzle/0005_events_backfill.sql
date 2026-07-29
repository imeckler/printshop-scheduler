-- Events system backfill.
--
-- The bookings GIST exclusion constraint forbade ANY overlapping bookings per
-- unit, which contradicts capacity-based semantics (units.capacity = 10) and
-- would block multi-attendee event timeslots. Capacity is now enforced
-- app-side in the printshop booking path. The matching stanza was also removed
-- from src/lib/migrations.sql (which only ever runs on fresh databases, AFTER
-- drizzle migrations — it would otherwise re-create the constraint).
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "no_overlap_per_unit";--> statement-breakpoint

-- Idempotency key for rrule materialization: one occurrence per event per start.
CREATE UNIQUE INDEX IF NOT EXISTS "event_timeslots_event_start_uq" ON "event_timeslots" ("event_id", lower("slot"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_timeslots_slot_gist" ON "event_timeslots" USING gist ("slot");--> statement-breakpoint

-- Existing approved+trained members are printshop users.
UPDATE "users" SET "printshop" = true WHERE "approved" AND "trained";--> statement-breakpoint

-- Convert every legacy booking (all statuses, preserving history) into a
-- single-timeslot finite event the booker is permissioned on. The bookings
-- table remains as a read-only legacy table (credit_transactions.booking_id
-- references it).
INSERT INTO "events" ("name", "created_by", "kind", "unit_id", "status", "legacy_booking_id", "created_at")
SELECT 'Printshop booking', b."user_id", 'finite', b."unit_id",
       CASE WHEN b."status" = 'confirmed' THEN 'active' ELSE 'cancelled' END,
       b."booking_id", b."created_at"
FROM "bookings" b;--> statement-breakpoint

INSERT INTO "event_timeslots" ("event_id", "slot", "generated", "status")
SELECT e."event_id", b."slot", false,
       CASE WHEN b."status" = 'confirmed' THEN 'confirmed' ELSE 'cancelled' END
FROM "events" e
JOIN "bookings" b ON b."booking_id" = e."legacy_booking_id";--> statement-breakpoint

INSERT INTO "event_permissions" ("user_id", "event_id")
SELECT b."user_id", e."event_id"
FROM "events" e
JOIN "bookings" b ON b."booking_id" = e."legacy_booking_id";
