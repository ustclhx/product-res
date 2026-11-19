-- rollback-safe: 只新增可空列、约束与部分唯一索引，旧代码不读写该列
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '15min';--> statement-breakpoint
ALTER TABLE "ai_task" ADD COLUMN "cancel_billing" text;--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation -- reason: drizzle 迁移在事务内执行无法 CONCURRENTLY；新列全为 NULL，部分索引为空，构建只扫描一次
CREATE UNIQUE INDEX "ai_task_workspace_free_started_cancel_idx" ON "ai_task" USING btree ("workspace_id") WHERE "ai_task"."cancel_billing" = 'free_started';--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- reason: 约束只涉及本迁移新增、全为 NULL 的列，校验无需改写或长时间持锁
ALTER TABLE "ai_task" ADD CONSTRAINT "ai_task_cancel_billing_valid" CHECK ("ai_task"."cancel_billing" in ('free_unstarted', 'free_started', 'charged'));
