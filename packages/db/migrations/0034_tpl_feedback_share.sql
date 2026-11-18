-- rollback-safe: 只新增带常量默认值的布尔列、可空时间列与只涉及这两列的 check 约束，旧代码不读写它们
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD COLUMN "share_conversation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- reason: 约束只涉及本迁移新增的两列，已有行恒为 false 与 NULL、校验恒为真且表很小，无需改写或长时间持锁
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_shared_at_consistent" CHECK ("ai_message_feedback"."share_conversation" is distinct from ("ai_message_feedback"."shared_at" is null));
