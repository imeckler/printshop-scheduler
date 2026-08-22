CREATE TABLE "authorizers" (
	"authorizer_id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"discord_user_id" text,
	"discord_username" text,
	"discord_access_token" text,
	"discord_refresh_token" text,
	"discord_token_expires_at" timestamp with time zone,
	"valid" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizers_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "authorizer_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "authorized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_authorizer_id_authorizers_authorizer_id_fk" FOREIGN KEY ("authorizer_id") REFERENCES "public"."authorizers"("authorizer_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: one built-in admin authorizer (always valid) and put every
-- existing user on it so nobody loses access when this ships.
INSERT INTO "authorizers" ("kind", "name") VALUES ('admin', 'Admin');--> statement-breakpoint
UPDATE "users" SET "authorizer_id" = (SELECT "authorizer_id" FROM "authorizers" WHERE "kind" = 'admin' LIMIT 1), "authorized" = true;
