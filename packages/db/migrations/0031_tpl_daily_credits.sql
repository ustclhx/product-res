-- rollback-safe: 只新增表和带默认值的列，旧代码不读写它们
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "credit_daily_claim" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"day" date NOT NULL,
	"grant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_daily_claim_user_day_unique" UNIQUE("user_id","day"),
	CONSTRAINT "credit_daily_claim_email_day_unique" UNIQUE("email_hash","day")
);
--> statement-breakpoint
-- squawk-ignore prefer-bigint-over-int -- reason: 每日发放次数与 metrics_daily 其余计数列一致使用 integer，单日不会接近上限
ALTER TABLE "metrics_daily" ADD COLUMN "daily_grant_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics_daily" ADD COLUMN "daily_grant_credits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_daily_claim" ADD CONSTRAINT "credit_daily_claim_grant_id_credit_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grant"("id") ON DELETE restrict ON UPDATE no action;