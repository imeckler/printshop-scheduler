CREATE TABLE "riso_last_seen_totals" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"last_seen_copies" integer DEFAULT 0 NOT NULL,
	"last_seen_stencils" integer DEFAULT 0 NOT NULL,
	"cumulative_copies_billed" integer DEFAULT 0 NOT NULL,
	"cumulative_stencils_billed" integer DEFAULT 0 NOT NULL,
	"last_report_date" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "riso_last_seen_totals" ADD CONSTRAINT "riso_last_seen_totals_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;