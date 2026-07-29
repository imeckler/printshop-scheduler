-- Additional PostgreSQL-specific features that Drizzle doesn't handle
-- Run this after your Drizzle migration to add triggers and constraints

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Create the credit balance upkeep function
CREATE OR REPLACE FUNCTION credit_balance_upkeep()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO credit_balances (user_id, balance_cents)
    VALUES (NEW.user_id, NEW.amount_cents)
    ON CONFLICT (user_id)
    DO UPDATE SET
        balance_cents = credit_balances.balance_cents + NEW.amount_cents,
        updated_at    = now();

    RETURN NEW;
END;
$$;

-- Create the trigger
CREATE TRIGGER credit_balance_tg
AFTER INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION credit_balance_upkeep();

-- Add the GIST exclusion constraints that Drizzle doesn't support.
-- Note: bookings deliberately has no exclusion constraint — overlap/capacity
-- for event timeslots is enforced app-side (see src/lib/events.ts), and
-- drizzle/0005_events_backfill.sql drops the old no_overlap_per_unit
-- constraint on existing databases.
ALTER TABLE blackouts ADD CONSTRAINT blackout_no_overlap
    EXCLUDE USING gist (unit_id WITH =, period WITH &&);

-- Add approved and trained columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trained BOOLEAN NOT NULL DEFAULT false;