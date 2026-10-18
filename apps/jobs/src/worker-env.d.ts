import type { MediaRuntimeEnv } from '@product-res/ai'
import type { PaymentRuntimeEnv } from '@product-res/billing'
import type { StorageEnv } from '@product-res/storage/cloudflare'
import type { SentryEnv } from './sentry.ts'

declare global {
  /** wrangler.jsonc 中声明的绑定（`import { env } from 'cloudflare:workers'` 与各 handler 的 env 类型） */
  declare namespace Cloudflare {
    interface Env
      extends Omit<PaymentRuntimeEnv, 'SENTRY_ENVIRONMENT'>,
        MediaRuntimeEnv,
        StorageEnv,
        SentryEnv {
      AI_FAULT_INJECTION?: string
      CRON_PROFILE?: string
      FILES: R2Bucket
      EVENTS_QUEUE: Queue<
        | import('@product-res/billing').BillingQueueMessage
        | import('./notifications/operations.ts').OperationsQueueMessage
      >
      EMAIL_QUEUE: Queue<import('@product-res/email/queue').EmailQueueMessage>
      /** 不带查询缓存（app-db）：Cron 写库 */
      HYPERDRIVE: Hyperdrive
      /** 与 web 共享认证缓存，用于删除后的失效重试。 */
      CACHE: KVNamespace
      /** 带查询缓存（app-db-cached） */
      HYPERDRIVE_CACHED: Hyperdrive
      AI_MEDIA_WORKFLOW: Workflow<import('./index.ts').AiMediaParams>
    }
  }
}
