CREATE TABLE "cost_param" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"category_id" text,
	"commission_rate" numeric(6, 4),
	"fixed_fee_minor" integer,
	"ad_rate" numeric(6, 4),
	"return_rate" numeric(6, 4),
	"storage_monthly_minor" integer,
	"storage_months" numeric(5, 2),
	"inbound_fee_minor" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "costing_scenario" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"planned_qty" integer NOT NULL,
	"sale_price_minor" integer,
	"currency" text,
	"improvement" jsonb,
	"result" jsonb NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "costing_scenario_qty_positive" CHECK ("costing_scenario"."planned_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scenario_id" uuid,
	"first_batch_qty" integer,
	"target_price_minor" integer,
	"currency" text,
	"planned_listing_on" date,
	"drop_reason" text,
	"drop_note" text,
	"snapshot" jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_drop_has_reason" CHECK ("decision"."kind" <> 'drop' or "decision"."drop_reason" is not null),
	CONSTRAINT "decision_first_batch_positive" CHECK ("decision"."first_batch_qty" is null or "decision"."first_batch_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "follow_outcome" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"review_days" integer DEFAULT 30 NOT NULL,
	"actual_units" integer NOT NULL,
	"actual_price_minor" integer,
	"currency" text,
	"comparison" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_outcome_units_valid" CHECK ("follow_outcome"."actual_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "logistics_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"type" text NOT NULL,
	"transit_days" integer NOT NULL,
	"head_freight" jsonb,
	"last_mile" jsonb,
	"banned_attributes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_profile_transit_days_valid" CHECK ("logistics_profile"."transit_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"platform" text DEFAULT 'other' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_quote" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"tiers" jsonb NOT NULL,
	"currency" text NOT NULL,
	"moq" integer,
	"weight_g" integer,
	"dimensions" jsonb,
	"confidence" text NOT NULL,
	"quoted_on" date NOT NULL,
	"procurement_days" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"import_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_quote_moq_positive" CHECK ("supplier_quote"."moq" is null or "supplier_quote"."moq" > 0),
	CONSTRAINT "supplier_quote_weight_positive" CHECK ("supplier_quote"."weight_g" is null or "supplier_quote"."weight_g" > 0)
);
--> statement-breakpoint
CREATE TABLE "category_study" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"marketplace" text NOT NULL,
	"category_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"top_n" integer DEFAULT 20 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_study_top_n_range" CHECK ("category_study"."top_n" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "category_study_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data_as_of" date,
	"modules" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"review_id" text NOT NULL,
	"rating" smallint,
	"title" text,
	"body" text,
	"reviewed_on" date,
	"source_id" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_review_rating_range" CHECK ("marketplace_review"."rating" is null or "marketplace_review"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "readiness_stat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"direction_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"computed_on" date NOT NULL,
	"shadow_count" integer DEFAULT 0 NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"import_count" integer DEFAULT 0 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"effective_samples" numeric(10, 2) DEFAULT 0 NOT NULL,
	"wilson_lower" numeric(6, 5),
	"baseline" numeric(6, 5),
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"cluster_id" uuid NOT NULL,
	"direction_id" uuid NOT NULL,
	"frozen_on" date NOT NULL,
	"marketplace" text NOT NULL,
	"signal_type" text NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"grade" text NOT NULL,
	"confidence" numeric(4, 3),
	"setting_version" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"sample_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_score_range" CHECK ("recommendation"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "recommendation_label" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"window_days" smallint NOT NULL,
	"outcome" text NOT NULL,
	"sales_delta" numeric(12, 2),
	"price_drop_rate" numeric(6, 5),
	"peak_week_error" numeric(5, 1),
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_label_window_valid" CHECK ("recommendation_label"."window_days" in (14, 30, 60))
);
--> statement-breakpoint
CREATE TABLE "weight_suggestion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL,
	"suggested_weights" jsonb NOT NULL,
	"current_weights" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cost_param" ADD CONSTRAINT "cost_param_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_scenario" ADD CONSTRAINT "costing_scenario_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_scenario" ADD CONSTRAINT "costing_scenario_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_scenario" ADD CONSTRAINT "costing_scenario_quote_id_supplier_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."supplier_quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costing_scenario" ADD CONSTRAINT "costing_scenario_profile_id_logistics_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."logistics_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_scenario_id_costing_scenario_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."costing_scenario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_outcome" ADD CONSTRAINT "follow_outcome_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_outcome" ADD CONSTRAINT "follow_outcome_decision_id_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_outcome" ADD CONSTRAINT "follow_outcome_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_profile" ADD CONSTRAINT "logistics_profile_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote" ADD CONSTRAINT "supplier_quote_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote" ADD CONSTRAINT "supplier_quote_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote" ADD CONSTRAINT "supplier_quote_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote" ADD CONSTRAINT "supplier_quote_import_id_data_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."data_import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quote" ADD CONSTRAINT "supplier_quote_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_study" ADD CONSTRAINT "category_study_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_study" ADD CONSTRAINT "category_study_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_study_snapshot" ADD CONSTRAINT "category_study_snapshot_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_study_snapshot" ADD CONSTRAINT "category_study_snapshot_study_id_category_study_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."category_study"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_review" ADD CONSTRAINT "marketplace_review_product_id_marketplace_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."marketplace_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_stat" ADD CONSTRAINT "readiness_stat_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_stat" ADD CONSTRAINT "readiness_stat_direction_id_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."direction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_direction_id_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."direction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_label" ADD CONSTRAINT "recommendation_label_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_label" ADD CONSTRAINT "recommendation_label_recommendation_id_recommendation_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_suggestion" ADD CONSTRAINT "weight_suggestion_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_suggestion" ADD CONSTRAINT "weight_suggestion_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_param_key_idx" ON "cost_param" USING btree ("workspace_id","platform",coalesce("category_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "costing_scenario_key_idx" ON "costing_scenario" USING btree ("lead_id","quote_id","profile_id","mode");--> statement-breakpoint
CREATE INDEX "costing_scenario_workspace_lead_idx" ON "costing_scenario" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_lead_idx" ON "decision" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "decision_workspace_decided_idx" ON "decision" USING btree ("workspace_id","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "follow_outcome_key_idx" ON "follow_outcome" USING btree ("decision_id","review_days");--> statement-breakpoint
CREATE INDEX "follow_outcome_workspace_idx" ON "follow_outcome" USING btree ("workspace_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_profile_workspace_name_idx" ON "logistics_profile" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "supplier_workspace_name_idx" ON "supplier" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "supplier_quote_workspace_cluster_idx" ON "supplier_quote" USING btree ("workspace_id","cluster_id","quoted_on");--> statement-breakpoint
CREATE INDEX "supplier_quote_supplier_idx" ON "supplier_quote" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_study_workspace_name_idx" ON "category_study" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "category_study_snapshot_study_idx" ON "category_study_snapshot" USING btree ("study_id","generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_review_key_idx" ON "marketplace_review" USING btree ("product_id","review_id");--> statement-breakpoint
CREATE INDEX "marketplace_review_product_rating_idx" ON "marketplace_review" USING btree ("product_id","rating");--> statement-breakpoint
CREATE UNIQUE INDEX "readiness_stat_key_idx" ON "readiness_stat" USING btree ("workspace_id","marketplace","direction_id","signal_type","computed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_lead_day_idx" ON "recommendation" USING btree ("lead_id","frozen_on");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_cluster_day_kind_idx" ON "recommendation" USING btree ("cluster_id","frozen_on","sample_kind");--> statement-breakpoint
CREATE INDEX "recommendation_workspace_frozen_idx" ON "recommendation" USING btree ("workspace_id","frozen_on");--> statement-breakpoint
CREATE INDEX "recommendation_stat_idx" ON "recommendation" USING btree ("workspace_id","marketplace","direction_id","signal_type");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_label_key_idx" ON "recommendation_label" USING btree ("recommendation_id","window_days");--> statement-breakpoint
CREATE INDEX "recommendation_label_workspace_idx" ON "recommendation_label" USING btree ("workspace_id","window_days","outcome");--> statement-breakpoint
CREATE INDEX "weight_suggestion_workspace_idx" ON "weight_suggestion" USING btree ("workspace_id","fitted_at" DESC NULLS LAST);