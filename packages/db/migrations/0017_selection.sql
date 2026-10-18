CREATE TABLE "brand_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"marketplace" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"direction_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"representative_product_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_member_confidence_range" CHECK ("cluster_member"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "cluster_signal" (
	"workspace_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"observed_on" date NOT NULL,
	"dimension" text NOT NULL,
	"score" numeric(5, 2),
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_signal_cluster_id_observed_on_dimension_pk" PRIMARY KEY("cluster_id","observed_on","dimension"),
	CONSTRAINT "cluster_signal_score_range" CHECK ("cluster_signal"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "direction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"marketplaces" text[] DEFAULT '{}'::text[] NOT NULL,
	"category_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"node_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "direction_seller" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"direction_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"seller_platform_id" text NOT NULL,
	"seller_name" text,
	"status" text NOT NULL,
	"reason" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"direction_id" uuid NOT NULL,
	"lead_on" date NOT NULL,
	"score" numeric(5, 2),
	"grade" text,
	"confidence" numeric(4, 3),
	"confidence_detail" jsonb,
	"gates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vetoed" boolean DEFAULT false NOT NULL,
	"latest_decision_on" date,
	"setting_version" integer NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_score_range" CHECK ("lead"."score" between 0 and 100),
	CONSTRAINT "lead_confidence_range" CHECK ("lead"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "lead_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"cluster_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_finding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"level" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"veto" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"level" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_setting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"reverse_dimensions" text[] NOT NULL,
	"veto_threshold" integer NOT NULL,
	"hard_gates" jsonb NOT NULL,
	"margin_floor_bp" integer NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_setting_version_positive" CHECK ("scoring_setting"."version" > 0),
	CONSTRAINT "scoring_setting_veto_range" CHECK ("scoring_setting"."veto_threshold" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "seasonal_node" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_month" smallint NOT NULL,
	"start_day" smallint NOT NULL,
	"sales_days" integer NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasonal_node_month_valid" CHECK ("seasonal_node"."start_month" between 1 and 12),
	CONSTRAINT "seasonal_node_day_valid" CHECK ("seasonal_node"."start_day" between 1 and 31),
	CONSTRAINT "seasonal_node_sales_days_positive" CHECK ("seasonal_node"."sales_days" between 1 and 366)
);
--> statement-breakpoint
ALTER TABLE "brand_entry" ADD CONSTRAINT "brand_entry_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster" ADD CONSTRAINT "cluster_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster" ADD CONSTRAINT "cluster_direction_id_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."direction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster" ADD CONSTRAINT "cluster_representative_product_id_marketplace_product_id_fk" FOREIGN KEY ("representative_product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_member" ADD CONSTRAINT "cluster_member_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_member" ADD CONSTRAINT "cluster_member_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_member" ADD CONSTRAINT "cluster_member_product_id_marketplace_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_signal" ADD CONSTRAINT "cluster_signal_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_signal" ADD CONSTRAINT "cluster_signal_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direction" ADD CONSTRAINT "direction_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direction_seller" ADD CONSTRAINT "direction_seller_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direction_seller" ADD CONSTRAINT "direction_seller_direction_id_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."direction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_direction_id_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."direction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_event" ADD CONSTRAINT "lead_event_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_event" ADD CONSTRAINT "lead_event_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_event" ADD CONSTRAINT "lead_event_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_event" ADD CONSTRAINT "lead_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_finding" ADD CONSTRAINT "risk_finding_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_finding" ADD CONSTRAINT "risk_finding_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_rule" ADD CONSTRAINT "risk_rule_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_setting" ADD CONSTRAINT "scoring_setting_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_setting" ADD CONSTRAINT "scoring_setting_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasonal_node" ADD CONSTRAINT "seasonal_node_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_entry_workspace_kind_idx" ON "brand_entry" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "cluster_workspace_direction_idx" ON "cluster" USING btree ("workspace_id","direction_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_member_cluster_product_idx" ON "cluster_member" USING btree ("cluster_id","product_id");--> statement-breakpoint
CREATE INDEX "cluster_member_workspace_product_idx" ON "cluster_member" USING btree ("workspace_id","product_id");--> statement-breakpoint
CREATE INDEX "cluster_signal_workspace_day_idx" ON "cluster_signal" USING btree ("workspace_id","observed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "direction_workspace_name_idx" ON "direction" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "direction_workspace_enabled_idx" ON "direction" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "direction_seller_key_idx" ON "direction_seller" USING btree ("direction_id","marketplace","seller_platform_id");--> statement-breakpoint
CREATE INDEX "direction_seller_workspace_idx" ON "direction_seller" USING btree ("workspace_id","direction_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_cluster_day_idx" ON "lead" USING btree ("cluster_id","lead_on");--> statement-breakpoint
CREATE INDEX "lead_workspace_direction_day_idx" ON "lead" USING btree ("workspace_id","direction_id","lead_on");--> statement-breakpoint
CREATE INDEX "lead_event_lead_idx" ON "lead_event" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_event_workspace_cluster_idx" ON "lead_event" USING btree ("workspace_id","cluster_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_finding_key_idx" ON "risk_finding" USING btree ("cluster_id","kind","ref");--> statement-breakpoint
CREATE INDEX "risk_finding_workspace_idx" ON "risk_finding" USING btree ("workspace_id","cluster_id");--> statement-breakpoint
CREATE INDEX "risk_rule_workspace_kind_idx" ON "risk_rule" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_setting_workspace_version_idx" ON "scoring_setting" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seasonal_node_workspace_name_idx" ON "seasonal_node" USING btree ("workspace_id","name");