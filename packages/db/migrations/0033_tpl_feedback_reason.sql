-- rollback-safe: 只新增可空列与只涉及该列的 check 约束，旧代码不读写它
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD COLUMN "reason" text;--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- reason: 约束只涉及本迁移新增、全为 NULL 的列，校验对已有行恒为真且表很小，无需改写或长时间持锁
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_reason_valid" CHECK ("ai_message_feedback"."reason" is null or ("ai_message_feedback"."rating" = 'down' and "ai_message_feedback"."reason" in ('inaccurate', 'incomplete', 'no_source', 'too_long')));
