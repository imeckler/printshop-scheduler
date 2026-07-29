ALTER TABLE "lock_activations" DROP CONSTRAINT "lock_activations_user_id_timeslot_id_pk";--> statement-breakpoint
ALTER TABLE "lock_activations" ADD COLUMN "activation_id" bigserial PRIMARY KEY NOT NULL;--> statement-breakpoint
-- At most one live (unrevoked) activation per user per occurrence; history
-- rows (revoked_at set) can accumulate freely.
CREATE UNIQUE INDEX "lock_activations_live_uq" ON "lock_activations" ("user_id", "timeslot_id") WHERE "revoked_at" IS NULL;
