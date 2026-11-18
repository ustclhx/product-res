-- rollback-safe: 只新增 app 对任务引擎表的读取与写入授权，旧代码不受影响
-- Cloudflare events 死信消费者以 app 账号写入 job_engine 死信表（harden-audit-findings D11）
GRANT USAGE ON SCHEMA "job_engine" TO app;--> statement-breakpoint
GRANT SELECT, INSERT ON "job_engine"."queue", "job_engine"."message", "job_engine"."dead_letter" TO app;
