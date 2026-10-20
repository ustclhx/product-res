import { parseAuthEnv } from '@product-res/auth'
import { loadEnv } from '@product-res/config'
import { loadNodeEnv, type NodeEnv, nodeStorageConfig } from '@product-res/config/node'
import { createDb, type Database } from '@product-res/db'
import type { EmailQueueMessage } from '@product-res/email/queue'
import {
  type ReplayMessage,
  SELECTION_REPLAY_QUEUE,
  STORE_TRACKING_QUEUE,
  type StoreRoundMessage,
} from '@product-res/follow'
import type { KeyValueStore, RequestMetadata, TaskHealth } from '@product-res/platform'
import {
  createNodeBackgroundTasks,
  createNodeCache,
  createNodeQueueProducer,
  createNodeRequestMetadata,
} from '@product-res/platform/node'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { getFileDownload } from '@product-res/storage'
import { createNodeStorage } from '@product-res/storage/node'
import { APIError } from 'better-auth/api'
import { z } from 'zod'
import { handleAuthRequest } from '../features/admin/impersonation-http.ts'
import { createBillingDeletionSteps } from '../features/billing/deletion.server.ts'
import { assertSignupAdmission } from '../features/growth/service.ts'
import { createWebAuth } from '../server/auth.ts'
import { createQueueAuthEmailSender, userLocaleByEmail } from '../server/auth-email.ts'
import type { WebRuntime } from '../server/runtime.ts'
import { templateConfig } from '../server/template-config.ts'
import { createNodeMediaWorkflowClient } from './media-workflow.ts'
import type { NodeWebObserver } from './observer-context.ts'

function unavailable(): never {
  throw new AppError('CAPABILITY_UNAVAILABLE', 'Capability is unavailable', { status: 503 })
}

/** 只供构建进程导入的 preview 使用：公开页 getter 失败走已有降级，不建立连接或读取密钥。 */
export function prerenderRuntime(requestMeta: RequestMetadata): WebRuntime {
  return {
    config: {
      APP_URL: templateConfig.app.url,
      BETTER_AUTH_SECRET: '',
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    },
    requestMeta,
    cache: { get: unavailable, put: unavailable, delete: unavailable },
    rateLimiter: { limit: unavailable },
    emailQueue: { available: false },
    eventsQueue: { available: false },
    files: { available: false },
    ai: { available: false },
    get db() {
      return unavailable()
    },
    get publicDb() {
      return unavailable()
    },
    get auth() {
      return unavailable()
    },
    createAuth: unavailable,
    handleAuthRequest: unavailable,
  }
}

/** 生产入口在 listen 前装配一次；请求引用进程 facade 并创建认证上下文。 */
export async function createNodeWebProcess(
  env: NodeEnv = loadNodeEnv({ templateConfig }),
  observer: Pick<NodeWebObserver, 'enabled' | 'captureError'> = {
    enabled: false,
    captureError: () => log.error('http.server_error'),
  },
) {
  const storageConfig = nodeStorageConfig(env)
  const storage = storageConfig ? createNodeStorage(storageConfig) : undefined
  const jobsConfig = loadEnv(
    process.env,
    z.object({
      JOBS_URL: z.url({ protocol: /^https?$/, hostname: /.+/ }).default('http://jobs:3001'),
    }),
  )
  const metadata = createNodeRequestMetadata(env.TRUSTED_PROXY_CIDRS.split(',').filter(Boolean))
  const db = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX })
  let cache: Awaited<ReturnType<typeof createNodeCache>>
  try {
    cache = await createNodeCache({ url: env.VALKEY_URL, namespace: env.CACHE_NAMESPACE })
  } catch (error) {
    await db.close()
    throw error
  }
  const background = createNodeBackgroundTasks()
  const emailQueue = createNodeQueueProducer<EmailQueueMessage>(db, 'product-res-email').producer
  const eventsQueue = createNodeQueueProducer<unknown>(db, 'product-res-events').producer
  // 回放消息由 jobs 的 selection 队列消费者处理（apps/jobs/src/selection/node.ts）
  const replayQueue = createNodeQueueProducer<ReplayMessage>(db, SELECTION_REPLAY_QUEUE).producer
  // 店铺追踪手动一轮由 jobs 的店铺追踪队列消费者处理（apps/jobs/src/stores/node.ts）
  const storeQueue = createNodeQueueProducer<StoreRoundMessage>(db, STORE_TRACKING_QUEUE).producer
  const jobsHealthSchema = z.object({
    queue: z.object({ status: z.enum(['up', 'down', 'unavailable']) }),
    scheduler: z.object({
      status: z.enum(['up', 'down', 'unavailable']),
      lastCronAt: z.iso.datetime().nullable(),
    }),
  })
  // 每次readiness只读一次jobs真实探测；web不启动DBOS或伪造consumer状态。
  let probing: Promise<z.output<typeof jobsHealthSchema>> | undefined
  const readJobsHealth = () => {
    probing ??= fetch(new URL('/internal/ready', jobsConfig.JOBS_URL), {
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    })
      .then(async (response) => {
        if (response.status !== 200 && response.status !== 503) throw new Error('Jobs probe failed')
        return jobsHealthSchema.parse(await response.json())
      })
      .finally(() => {
        probing = undefined
      })
    return probing
  }
  const taskHealth: TaskHealth = {
    queue: async () => {
      try {
        return (await readJobsHealth()).queue
      } catch {
        return { status: 'down' }
      }
    },
    scheduler: async () => {
      try {
        return (await readJobsHealth()).scheduler
      } catch {
        return { status: 'down', lastCronAt: null }
      }
    },
  }
  const config = {
    ...parseAuthEnv(env, templateConfig),
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
    PAYMENT_MODE: env.PAYMENT_MODE,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    AI_FAULT_INJECTION: env.AI_FAULT_INJECTION,
    ...(env.STRIPE_SECRET_KEY === undefined ? {} : { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY }),
    ...(env.STRIPE_WEBHOOK_SECRET === undefined
      ? {}
      : { STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET }),
    ...(env.PAYPAL_CLIENT_ID === undefined ? {} : { PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID }),
    ...(env.PAYPAL_CLIENT_SECRET === undefined
      ? {}
      : { PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET }),
    ...(env.PAYPAL_WEBHOOK_ID === undefined ? {} : { PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID }),
  }
  const requestRuntime = (requestMeta: RequestMetadata): WebRuntime => {
    const authCache = cache.kv('auth')
    const createAuth = (database: Database, secondaryCache: KeyValueStore = authCache) =>
      createWebAuth(config, database, {
        cache: secondaryCache,
        rateLimiter: cache.rateLimiter,
        clientIp: requestMeta.clientIp,
        sendEmail: createQueueAuthEmailSender({
          queue: emailQueue,
          appName: templateConfig.app.name,
          appUrl: config.APP_URL,
          resolveLocale: userLocaleByEmail(database),
        }),
        deletionSteps: createBillingDeletionSteps(config, database, authCache),
        beforeUserCreate: async (user, headers) => {
          try {
            await assertSignupAdmission(
              { db: database, config: templateConfig, secret: config.BETTER_AUTH_SECRET },
              user.email,
              headers,
            )
          } catch (error) {
            if (error instanceof AppError)
              throw APIError.from('FORBIDDEN', { code: error.code, message: error.message })
            throw error
          }
        },
      })
    let auth: ReturnType<typeof createAuth> | undefined
    const runtime: WebRuntime = {
      config,
      db,
      publicDb: db,
      cache: cache.kv('settings'),
      rateLimiter: cache.rateLimiter,
      requestMeta,
      observability: observer,
      emailQueue: { available: true, value: emailQueue },
      eventsQueue: { available: true, value: eventsQueue },
      selectionReplayQueue: { available: true, value: replayQueue },
      storeTrackingQueue: { available: true, value: storeQueue },
      health: { cache: () => cache.ping(), tasks: taskHealth },
      files: storage ? { available: true, value: storage } : { available: false },
      ai: {
        available: true,
        value: {
          config: {
            AI_FAULT_INJECTION: env.AI_FAULT_INJECTION,
            SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
            AI_TEXT_EGRESS: env.AI_TEXT_EGRESS,
            OPENAI_BASE_URL: env.OPENAI_BASE_URL,
            OPENAI_API_KEY: env.OPENAI_API_KEY,
            ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
            GOOGLE_API_KEY: env.GOOGLE_API_KEY,
            DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
            AI_GATEWAY_ACCOUNT_ID: env.AI_GATEWAY_ACCOUNT_ID,
            AI_GATEWAY_ID: env.AI_GATEWAY_ID,
            AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
            ...(env.FAL_KEY === undefined ? {} : { FAL_KEY: env.FAL_KEY }),
            ...(env.MEDIA_WEBHOOK_SECRET === undefined
              ? {}
              : { MEDIA_WEBHOOK_SECRET: env.MEDIA_WEBHOOK_SECRET }),
          },
          workersAi: { available: false },
          background,
          workflow:
            storage &&
            (templateConfig.ai.image || templateConfig.ai.video) &&
            env.MEDIA_WEBHOOK_SECRET
              ? {
                  available: true,
                  value: createNodeMediaWorkflowClient({
                    jobsUrl: jobsConfig.JOBS_URL,
                    secret: env.MEDIA_WEBHOOK_SECRET,
                  }),
                }
              : { available: false },
          downloadFile: storage
            ? { available: true, value: (input) => getFileDownload(db, storage, input) }
            : { available: false },
        },
      },
      get auth() {
        auth ??= createAuth(db)
        return auth
      },
      createAuth,
      handleAuthRequest: (request) => handleAuthRequest(request, runtime),
    }
    return runtime
  }
  return {
    env,
    background,
    metadata,
    requestRuntime,
    close: async () => {
      await Promise.all([cache.close(), db.close()])
    },
  }
}
