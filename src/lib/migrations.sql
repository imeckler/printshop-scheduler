-- Additional PostgreSQL-specific features that Drizzle doesn't handle
-- Run this after your Drizzle migration to add triggers and constraints

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

    -- Safety-net: disallow negative wallet
    IF (SELECT balance_cents FROM credit_balances WHERE user_id = NEW.user_id) < 0
    THEN
        RAISE EXCEPTION 'Insufficient credits (user_id=%)', NEW.user_id;
    END IF;

    RETURN NEW;
END;
$$;

-- Create the trigger
CREATE TRIGGER credit_balance_tg
AFTER INSERT ON credit_transactions
FOR EACH ROW EXECUTE FUNCTION credit_balance_upkeep();

-- Add the GIST exclusion constraints that Drizzle doesn't support
ALTER TABLE bookings ADD CONSTRAINT no_overlap_per_unit
    EXCLUDE USING gist (unit_id WITH =, slot WITH &&);

ALTER TABLE blackouts ADD CONSTRAINT blackout_no_overlap
    EXCLUDE USING gist (unit_id WITH =, period WITH &&);