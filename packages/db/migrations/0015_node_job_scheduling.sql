CREATE TABLE "job_engine"."schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"cron" text NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"missed_run" text DEFAULT 'skip' NOT NULL,
	"next_scheduled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_engine"."schedule_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"executor_id" text,
	"executor_token" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text
);
--> statement-breakpoint
ALTER TABLE "job_engine"."schedule_run" ADD CONSTRAINT "schedule_run_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "job_engine"."schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_run_slot_idx" ON "job_engine"."schedule_run" USING btree ("schedule_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_run_active_idx" ON "job_engine"."schedule_run" USING btree ("schedule_id") WHERE "job_engine"."schedule_run"."state" IN ('claimed', 'running');