CREATE TABLE "print_request_files" (
	"file_id" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_requests" (
	"request_id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone_e164" text NOT NULL,
	"needed_by" date NOT NULL,
	"print_type" text NOT NULL,
	"print_type_other" text,
	"desired_size" text,
	"strict_size" boolean DEFAULT false NOT NULL,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"claimed_by_user_id" bigint,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"pickup_details" text,
	"notification_channel" text,
	"notification_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "print_squad" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "print_request_files" ADD CONSTRAINT "print_request_files_request_id_print_requests_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."print_requests"("request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_claimed_by_user_id_users_user_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;