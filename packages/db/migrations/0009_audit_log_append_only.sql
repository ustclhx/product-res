-- 审计日志只追加（add-admin-console design.md 决策 4，specs/audit-log「只追加」）：
-- 应用账号 app 只保留 SELECT / INSERT，撤销 UPDATE / DELETE / TRUNCATE。
-- 新库由 infra/local/initdb/02-db-grants.sql 在授权后再次撤销，保持一致。
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM app;
