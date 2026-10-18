CREATE SCHEMA "job_engine";
--> statement-breakpoint
CREATE TABLE "job_engine"."batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"size" integer NOT NULL,
	"executor_id" text,
	"executor_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_engine"."dead_letter" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"attempts" integer NOT NULL,
	"code" text NOT NULL,
	"retryable" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_engine"."message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"body" jsonb NOT NULL,
	"request_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_engine"."queue" (
	"name" text PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_engine"."start" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"message_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_engine"."batch" ADD CONSTRAINT "batch_queue_queue_name_fk" FOREIGN KEY ("queue") REFERENCES "job_engine"."queue"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_engine"."dead_letter" ADD CONSTRAINT "dead_letter_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "job_engine"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_engine"."message" ADD CONSTRAINT "message_queue_queue_name_fk" FOREIGN KEY ("queue") REFERENCES "job_engine"."queue"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_engine"."message" ADD CONSTRAINT "message_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "job_engine"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_engine"."start" ADD CONSTRAINT "start_queue_queue_name_fk" FOREIGN KEY ("queue") REFERENCES "job_engine"."queue"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_message_ready_idx" ON "job_engine"."message" USING btree ("queue","state","available_at");--> statement-breakpoint
CREATE INDEX "job_message_batch_idx" ON "job_engine"."message" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "job_start_window_idx" ON "job_engine"."start" USING btree ("queue","started_at");