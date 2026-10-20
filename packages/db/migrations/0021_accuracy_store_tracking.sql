CREATE TABLE "accuracy_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"week_of" date NOT NULL,
	"seed" text NOT NULL,
	"sample_size" integer NOT NULL,
	"sampling" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "accuracy_audit_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"collected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actual" jsonb,
	"agreement" jsonb,
	"checked_at" timestamp with time zone,
	"checked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "source_qualification" (
	"source_id" text NOT NULL,
	"metric" text NOT NULL,
	"disqualified" boolean DEFAULT false NOT NULL,
	"agreement_rate" numeric(6, 5),
	"samples" integer DEFAULT 0 NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_qualification_source_id_metric_pk" PRIMARY KEY("source_id","metric")
);
--> statement-breakpoint
CREATE TABLE "store_listing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"seller_key" text NOT NULL,
	"product_id" uuid NOT NULL,
	"first_seen_on" date NOT NULL,
	"last_seen_on" date NOT NULL,
	"delisted_on" date,
	"discovery" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"tier" text DEFAULT 'normal' NOT NULL,
	"tier_reason" text,
	"tier_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin" text NOT NULL,
	"origin_ref" uuid,
	"last_snapshot_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_store" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"marketplace" text NOT NULL,
	"seller_key" text NOT NULL,
	"display_name" text,
	"url" text,
	"kind" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'active' NOT NULL,
	"direction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_product" ADD COLUMN "parent_platform_id" text;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "tier" smallint;--> statement-breakpoint
-- 已有观测按获取方式回填层级（design D1）：official→1、import→2、estimate→3、derived→4
UPDATE "observation" SET "tier" = CASE "method" WHEN 'official' THEN 1 WHEN 'import' THEN 2 WHEN 'estimate' THEN 3 ELSE 4 END;--> statement-breakpoint
ALTER TABLE "observation" ALTER COLUMN "tier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "value_low" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "value_high" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "observation" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "accuracy_audit" ADD CONSTRAINT "accuracy_audit_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_audit" ADD CONSTRAINT "accuracy_audit_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_audit_item" ADD CONSTRAINT "accuracy_audit_item_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_audit_item" ADD CONSTRAINT "accuracy_audit_item_audit_id_accuracy_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."accuracy_audit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_audit_item" ADD CONSTRAINT "accuracy_audit_item_product_id_marketplace_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accuracy_audit_item" ADD CONSTRAINT "accuracy_audit_item_checked_by_user_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listing" ADD CONSTRAINT "store_listing_product_id_marketplace_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_product" ADD CONSTRAINT "tracked_product_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_product" ADD CONSTRAINT "tracked_product_product_id_marketplace_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_store" ADD CONSTRAINT "tracked_store_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accuracy_audit_week_idx" ON "accuracy_audit" USING btree ("workspace_id","week_of");--> statement-breakpoint
CREATE UNIQUE INDEX "accuracy_audit_item_key_idx" ON "accuracy_audit_item" USING btree ("audit_id","product_id");--> statement-breakpoint
CREATE INDEX "accuracy_audit_item_workspace_idx" ON "accuracy_audit_item" USING btree ("workspace_id","audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_listing_key_idx" ON "store_listing" USING btree ("platform","seller_key","product_id");--> statement-breakpoint
CREATE INDEX "store_listing_seller_seen_idx" ON "store_listing" USING btree ("platform","seller_key","first_seen_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_listing_product_idx" ON "store_listing" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_product_key_idx" ON "tracked_product" USING btree ("workspace_id","product_id");--> statement-breakpoint
CREATE INDEX "tracked_product_workspace_tier_idx" ON "tracked_product" USING btree ("workspace_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_store_key_idx" ON "tracked_store" USING btree ("workspace_id","marketplace","seller_key");--> statement-breakpoint
CREATE INDEX "tracked_store_workspace_status_idx" ON "tracked_store" USING btree ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_tier_range" CHECK ("observation"."tier" between 0 and 4);