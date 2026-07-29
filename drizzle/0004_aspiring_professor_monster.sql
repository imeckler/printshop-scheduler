CREATE TABLE "event_permissions" (
	"user_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_permissions_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "event_timeslots" (
	"timeslot_id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" bigint,
	"kind" text NOT NULL,
	"unit_id" integer,
	"rrule" text,
	"duration_minutes" integer,
	"timezone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"legacy_booking_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_legacy_booking_id_unique" UNIQUE("legacy_booking_id")
);
--> statement-breakpoint
CREATE TABLE "lock_activations" (
	"user_id" bigint NOT NULL,
	"timeslot_id" bigint NOT NULL,
	"access_start" timestamp with time zone NOT NULL,
	"access_stop" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lock_activations_user_id_timeslot_id_pk" PRIMARY KEY("user_id","timeslot_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "printshop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "event_creator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_permissions" ADD CONSTRAINT "event_permissions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_permissions" ADD CONSTRAINT "event_permissions_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_timeslots" ADD CONSTRAINT "event_timeslots_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_unit_id_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("unit_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lock_activations" ADD CONSTRAINT "lock_activations_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lock_activations" ADD CONSTRAINT "lock_activations_timeslot_id_event_timeslots_timeslot_id_fk" FOREIGN KEY ("timeslot_id") REFERENCES "public"."event_timeslots"("timeslot_id") ON DELETE cascade ON UPDATE no action;