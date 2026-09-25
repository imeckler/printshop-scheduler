ALTER TABLE "users" ADD COLUMN "discord_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_username" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_discord_user_id_unique" UNIQUE("discord_user_id");