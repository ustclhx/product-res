CREATE TABLE "payment_refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_refund_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_provider_refund_unique" UNIQUE("provider","provider_refund_id"),
	CONSTRAINT "payment_refund_amount_positive" CHECK ("payment_refund"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "plan_price_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_refund_workspace_id_id_idx" ON "payment_refund" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_plan_price_id_plan_price_id_fk" FOREIGN KEY ("plan_price_id") REFERENCES "public"."plan_price"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_period_pair" CHECK (("payment"."period_start" is null and "payment"."period_end" is null) or ("payment"."period_start" is not null and "payment"."period_end" is not null and "payment"."period_end" > "payment"."period_start"));