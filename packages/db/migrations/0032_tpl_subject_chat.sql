-- rollback-safe: 只新增表与可空列，旧代码不读写它们
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "ai_message_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"comment" text,
	"model_key" text,
	"subject_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_message_feedback_rating_valid" CHECK ("ai_message_feedback"."rating" in ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "ai_conversation" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_message_id_ai_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_message_feedback_message_user_idx" ON "ai_message_feedback" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_message_feedback_workspace_id_id_idx" ON "ai_message_feedback" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_message_feedback_created_at_idx" ON "ai_message_feedback" USING btree ("created_at");--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation -- reason: drizzle 迁移在事务内执行无法 CONCURRENTLY；新列全为 NULL，索引构建只扫描一次
CREATE INDEX "ai_conversation_workspace_subject_idx" ON "ai_conversation" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- reason: 约束只涉及本迁移新增、全为 NULL 的列，校验无需改写或长时间持锁
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_subject_pair" CHECK (("ai_conversation"."subject_type" is null) = ("ai_conversation"."subject_id" is null));