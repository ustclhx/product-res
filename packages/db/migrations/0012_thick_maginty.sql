CREATE TABLE "ai_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"model_key" text NOT NULL,
	"pricing" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"provider" text NOT NULL,
	"provider_job_id" text,
	"provider_request_key" text NOT NULL,
	"callback_payload" jsonb,
	"workflow_instance_id" text,
	"hold_id" uuid,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_task_kind_valid" CHECK ("ai_task"."kind" in ('image', 'video')),
	CONSTRAINT "ai_task_status_valid" CHECK ("ai_task"."status" in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "ai_task_credits_charged_nonnegative" CHECK ("ai_task"."credits_charged" >= 0)
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"r2_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration" double precision,
	"source_task_id" uuid,
	"public_token" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "file_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "file_status_valid" CHECK ("file"."status" in ('pending', 'ready')),
	CONSTRAINT "file_size_nonnegative" CHECK ("file"."size" >= 0),
	CONSTRAINT "file_dimensions_positive" CHECK ("file"."width" > 0 and "file"."height" > 0),
	CONSTRAINT "file_duration_nonnegative" CHECK ("file"."duration" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_hold_id_credit_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_hold"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_source_task_id_ai_task_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."ai_task"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_task_workspace_id_id_idx" ON "ai_task" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_task_status_updated_at_idx" ON "ai_task" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "file_workspace_id_id_idx" ON "file" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "file_status_created_at_idx" ON "file" USING btree ("status","created_at");