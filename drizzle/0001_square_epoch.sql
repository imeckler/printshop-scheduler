CREATE TABLE "risograph_usages" (
	"usage_id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"copies_printed" integer DEFAULT 0 NOT NULL,
	"stencils_created" integer DEFAULT 0 NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_data" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "code" text;--> statement-breakpoint
UPDATE "users" SET "code" = 'USER' || "user_id" WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risograph_usages" ADD CONSTRAINT "risograph_usages_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_code_unique" UNIQUE("code");