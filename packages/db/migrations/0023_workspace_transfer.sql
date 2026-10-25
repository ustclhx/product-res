CREATE TABLE "workspace_transfer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"target_workspace_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workspace_transfer_distinct_workspaces" CHECK ("workspace_transfer"."source_workspace_id" <> "workspace_transfer"."target_workspace_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_transfer_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"batch_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_transfer_id_map" (
	"transfer_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text,
	"action" text NOT NULL,
	"batch_key" text,
	"source_row" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_transfer_id_map_transfer_id_table_name_source_id_pk" PRIMARY KEY("transfer_id","table_name","source_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_transfer" ADD CONSTRAINT "workspace_transfer_source_workspace_id_organization_id_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfer" ADD CONSTRAINT "workspace_transfer_target_workspace_id_organization_id_fk" FOREIGN KEY ("target_workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfer" ADD CONSTRAINT "workspace_transfer_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfer_batch" ADD CONSTRAINT "workspace_transfer_batch_transfer_id_workspace_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."workspace_transfer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_transfer_id_map" ADD CONSTRAINT "workspace_transfer_id_map_transfer_id_workspace_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."workspace_transfer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_transfer_idempotency_idx" ON "workspace_transfer" USING btree ("requested_by","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_transfer_active_source_idx" ON "workspace_transfer" USING btree ("source_workspace_id") WHERE "workspace_transfer"."status" in ('pending', 'running', 'compensating');--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_transfer_active_target_idx" ON "workspace_transfer" USING btree ("target_workspace_id") WHERE "workspace_transfer"."status" in ('pending', 'running', 'compensating');--> statement-breakpoint
CREATE INDEX "workspace_transfer_source_idx" ON "workspace_transfer" USING btree ("source_workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspace_transfer_target_idx" ON "workspace_transfer" USING btree ("target_workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_transfer_batch_key_idx" ON "workspace_transfer_batch" USING btree ("transfer_id","batch_key");--> statement-breakpoint
CREATE INDEX "workspace_transfer_batch_seq_idx" ON "workspace_transfer_batch" USING btree ("transfer_id","seq");--> statement-breakpoint
CREATE INDEX "workspace_transfer_id_map_batch_idx" ON "workspace_transfer_id_map" USING btree ("transfer_id","batch_key");