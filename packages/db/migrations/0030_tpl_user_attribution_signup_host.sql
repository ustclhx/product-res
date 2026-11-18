-- rollback-safe: 只新增可空列，旧代码不读写该列
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "user_attribution" ADD COLUMN "signup_host" text;
