CREATE TABLE "billing_compensation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancel_completed" boolean DEFAULT false NOT NULL,
	"provider_refund_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_compensation_key_unique" UNIQUE("key"),
	CONSTRAINT "billing_compensation_attempts_nonnegative" CHECK ("billing_compensation"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_compensation" ADD CONSTRAINT "billing_compensation_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_compensation_workspace_id_id_idx" ON "billing_compensation" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_compensation_retry_idx" ON "billing_compensation" USING btree ("status","lease_until");