CREATE TABLE "budget_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"period_key" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"mode" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"template_id" uuid,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"raw_payload_id" uuid,
	"context" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"imported_count" integer NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_quality_issue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_id" text,
	"entity_type" text,
	"entity_id" uuid,
	"metric" text,
	"detail" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_source" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_probe" jsonb,
	"paused_reason" text,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_keyword" (
	"id" uuid PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"phrase" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"platform_id" text NOT NULL,
	"gtin" text,
	"title" text,
	"brand" text,
	"category_id" text,
	"image_url" text,
	"url" text,
	"seller_id" text,
	"listed_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_seller" (
	"id" uuid PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"platform_id" text NOT NULL,
	"name" text,
	"url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_priority" (
	"marketplace" text NOT NULL,
	"metric" text NOT NULL,
	"sources" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_priority_marketplace_metric_pk" PRIMARY KEY("marketplace","metric")
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"observed_on" date NOT NULL,
	"source_id" text NOT NULL,
	"value" numeric(24, 6) NOT NULL,
	"currency" text,
	"method" text NOT NULL,
	"raw_payload_id" uuid,
	"import_id" uuid,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "observation_entity_type_entity_id_metric_observed_on_source_id_pk" PRIMARY KEY("entity_type","entity_id","metric","observed_on","source_id")
);
--> statement-breakpoint
CREATE TABLE "raw_payload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"run_id" uuid,
	"import_id" uuid,
	"task" jsonb NOT NULL,
	"request" jsonb NOT NULL,
	"status" integer NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text DEFAULT 'application/json' NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text,
	"body" "bytea",
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_budget" (
	"source_id" text NOT NULL,
	"period_key" text NOT NULL,
	"unit" text NOT NULL,
	"hard_cap" bigint NOT NULL,
	"safety_line" bigint NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"settled" bigint DEFAULT 0 NOT NULL,
	"external_remaining" bigint,
	"external_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_budget_source_id_period_key_pk" PRIMARY KEY("source_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"data_kind" text NOT NULL,
	"marketplace" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"planned" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_import" ADD CONSTRAINT "data_import_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_ledger_reservation_idx" ON "budget_ledger" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "budget_ledger_source_period_idx" ON "budget_ledger" USING btree ("source_id","period_key");--> statement-breakpoint
CREATE INDEX "data_import_sha_idx" ON "data_import" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "data_import_created_idx" ON "data_import" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "data_quality_issue_fingerprint_idx" ON "data_quality_issue" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "data_quality_issue_status_idx" ON "data_quality_issue" USING btree ("status","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "import_template_source_name_idx" ON "import_template" USING btree ("source_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_keyword_key_idx" ON "marketplace_keyword" USING btree ("marketplace","phrase");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_product_key_idx" ON "marketplace_product" USING btree ("marketplace","platform_id");--> statement-breakpoint
CREATE INDEX "marketplace_product_seller_idx" ON "marketplace_product" USING btree ("marketplace","seller_id");--> statement-breakpoint
CREATE INDEX "marketplace_product_gtin_idx" ON "marketplace_product" USING btree ("gtin");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_seller_key_idx" ON "marketplace_seller" USING btree ("marketplace","platform_id");--> statement-breakpoint
CREATE INDEX "observation_metric_day_idx" ON "observation" USING btree ("metric","observed_on");--> statement-breakpoint
CREATE INDEX "observation_import_idx" ON "observation" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "observation_source_day_idx" ON "observation" USING btree ("source_id","observed_on");--> statement-breakpoint
CREATE INDEX "raw_payload_run_idx" ON "raw_payload" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "raw_payload_source_fetched_idx" ON "raw_payload" USING btree ("source_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_payload_expires_idx" ON "raw_payload" USING btree ("expires_at") WHERE "raw_payload"."purged_at" is null;--> statement-breakpoint
CREATE INDEX "sync_run_source_started_idx" ON "sync_run" USING btree ("source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_run_status_idx" ON "sync_run" USING btree ("status","started_at" DESC NULLS LAST);