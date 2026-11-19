-- rollback-safe: 只改写历史审计行的 meta 内容，表结构不变，旧代码可读取新格式
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '15min';--> statement-breakpoint
-- 审计元数据不再保存个人信息（harden-audit-findings D8）：以 migrator 身份改写历史行，app 仍只能追加。
-- 邀请成员：去掉被邀请人邮箱（target_id 已是邀请 ID）。
UPDATE "audit_log" SET "meta" = "meta" - 'email'
WHERE "action" = 'workspace.member_invited' AND "meta" ? 'email';--> statement-breakpoint
-- 代登录修改资料：前后姓名与头像改为只记字段名，与新写入格式 { fields, impersonatedBy } 一致。
UPDATE "audit_log" SET "meta" = jsonb_build_object(
  'fields', coalesce((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys("meta"->'after') AS k), '[]'::jsonb),
  'impersonatedBy', "meta"->'impersonatedBy'
)
WHERE "action" = 'user.profile_updated' AND jsonb_typeof("meta"->'after') = 'object';
