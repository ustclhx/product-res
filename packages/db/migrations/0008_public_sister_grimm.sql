CREATE TABLE "ai_conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"model_key" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_key" text,
	"pricing" jsonb,
	"status" text DEFAULT 'completed' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"usage_checkpoint" jsonb,
	"credits" integer,
	"hold_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_message_usage_nonnegative" CHECK (coalesce("ai_message"."input_tokens", 0) >= 0 and coalesce("ai_message"."output_tokens", 0) >= 0 and coalesce("ai_message"."credits", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_model" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"pricing" jsonb NOT NULL,
	"min_plan_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params_schema" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_conversation_id_ai_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_hold_id_credit_hold_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_hold"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversation_workspace_id_id_idx" ON "ai_conversation" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_conversation_workspace_user_id_idx" ON "ai_conversation" USING btree ("workspace_id","user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_message_workspace_id_id_idx" ON "ai_message" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_message_conversation_id_id_idx" ON "ai_message" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "ai_model_enabled_sort_idx" ON "ai_model" USING btree ("enabled","sort");