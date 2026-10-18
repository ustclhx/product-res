CREATE TABLE "job_engine"."workflow_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"workflow_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_engine"."workflow_wait" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "workflow_event_fifo_idx" ON "job_engine"."workflow_event" USING btree ("workflow_id","type","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_wait_name_idx" ON "job_engine"."workflow_wait" USING btree ("workflow_id","name");