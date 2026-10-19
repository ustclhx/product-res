/** wrangler.jsonc 中声明的绑定（`import { env } from 'cloudflare:workers'` 的类型） */
declare namespace Cloudflare {
  type PaymentEnv = import('@product-res/billing').PaymentRuntimeEnv
  type StorageEnv = import('@product-res/storage/cloudflare').StorageEnv
  type MediaEnv = import('@product-res/ai').MediaRuntimeEnv
  type TextEnv = import('@product-res/ai').TextModelEnv
  interface Env extends PaymentEnv, StorageEnv, MediaEnv, TextEnv {
    AI_FAULT_INJECTION?: string
    SENTRY_DSN?: string
    SENTRY_ENVIRONMENT?: 'development' | 'staging' | 'production' | 'smoke'
    /** 不带查询缓存（app-db）：健康检查与写操作 */
    HYPERDRIVE: Hyperdrive
    /** 带查询缓存（app-db-cached）：可容忍短暂旧数据的读 */
    HYPERDRIVE_CACHED: Hyperdrive
    /** 定义在 apps/jobs 的 AiMediaWorkflow（script_name: jobs）；参数类型在 P4 移入 packages/ai */
    AI_MEDIA_WORKFLOW: Workflow<{ taskId: string }>
    /** 邮件队列 producer，apps/jobs 消费（消息格式见 @product-res/email/queue） */
    EVENTS_QUEUE: Queue<
      | import('@product-res/billing').BillingQueueMessage
      | import('./features/notifications/operations.ts').OperationsQueueMessage
    >
    EMAIL_QUEUE: Queue<import('@product-res/email/queue').EmailQueueMessage>
    /** KV：Better Auth 会话的 secondaryStorage（packages/auth/src/session.ts） */
    CACHE: KVNamespace
    /** Rate Limiting：认证入口按 IP + 邮箱限流（packages/auth/src/protection.ts） */
    RL_AUTH: RateLimit
    /** Rate Limiting：AI 接口按空间 + 用户限流（features/ai/chat.ts），只用于防刷 */
    RL_AI: RateLimit
    /** 公开 API 按 Key 和空间限流 */
    RL_API: RateLimit
    /** 站点地址（vars；`vite dev` 时由 vite.config.ts 按端口覆盖） */
    APP_URL: string
    /** Turnstile site key（vars，前端公开）；模板配置启用 Turnstile 时必填 */
    TURNSTILE_SITE_KEY?: string
    // 以下为 secrets（wrangler secret / .dev.vars），按模板配置在 checkEnv 中校验
    BETTER_AUTH_SECRET?: string
    /** 可选首次管理员邮箱名单；仅已验证且未封禁账号会被提升 */
    BOOTSTRAP_ADMIN_EMAILS?: string
    /** 'true' 时名单账号无需验证邮箱即被提升；须配合只放行运维邮箱的注册白名单，提升后关闭 */
    BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED?: string
    SIGNUP_ALLOWED_EMAILS?: string
    TURNSTILE_SECRET_KEY?: string
    GOOGLE_CLIENT_ID?: string
    GOOGLE_CLIENT_SECRET?: string
    GITHUB_CLIENT_ID?: string
    GITHUB_CLIENT_SECRET?: string
  }
}
