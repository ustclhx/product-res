// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
// /admin/** 的请求先经角色守卫，非 admin 与不存在的页面得到相同的 404（features/admin/gate.ts）。
// 之后由 Paraglide 按 URL 前缀 / Cookie 确定本次请求的语言（features/i18n/routing.ts）。
// 每个请求先建立日志上下文（新生成的 UUIDv7 请求 ID，附 Cloudflare 的 cf-ray 便于对照平台日志），
// 结束时输出一行 `http.request`（@product-res/shared/log）。
import { type AuthEmail, parseAuthEnv, type SendAuthEmail } from '@product-res/auth'
import { loadEnv, plausibleSite } from '@product-res/config'
import type { Database } from '@product-res/db'
import type { KeyValueStore, RequestMetadata } from '@product-res/platform'
import {
  createCloudflareBackgroundTasks,
  createCloudflareDatabase,
  createCloudflareKv,
  createCloudflareQueue,
  createCloudflareRateLimiter,
  createCloudflareRequestMetadata,
  createCloudflareWorkflow,
} from '@product-res/platform/cloudflare'
import { AppError, toErrorResponse } from '@product-res/shared'
import { log, redactUrlPath, withLogContext } from '@product-res/shared/log'
import { createShareCardInvalidator, getFileDownload } from '@product-res/storage'
import { createCloudflareStorage } from '@product-res/storage/cloudflare'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { APIError } from 'better-auth/api'
import { gateAdminRequest } from './features/admin/gate.ts'
import { handleAuthRequest } from './features/admin/impersonation-http.ts'
import { createSignUpRecorder } from './features/analytics/server.ts'
import {
  gatePublicApiRequest,
  isPublicApiPath,
  normalizePublicApiNotFound,
} from './features/api-keys/gate.ts'
import { createBillingDeletionSteps } from './features/billing/deletion.server.ts'
import { assertSignupAdmission } from './features/growth/service.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { localizeRequest } from './features/i18n/request.server.ts'
import { withSecurityNonce } from './security-context.server.ts'
import { withSecurityHeaders, withStaticSecurityHeaders } from './security-headers.ts'
import { createWebAuth } from './server/auth.ts'
import { createQueueAuthEmailSender, userLocaleByEmail } from './server/auth-email.ts'
import { checkEnv, webEnvSchema } from './server/cloudflare/env.ts'
import { captureServerError, instrumentWeb, sentryEnabled } from './server/cloudflare/sentry.ts'
import { getWebRuntime, type WebRuntime, withWebRuntime } from './server/runtime.ts'
import { SENTRY_TEST_PATH, sentryTest } from './server/sentry-test.ts'
import { templateConfig } from './server/template-config.ts'

// Router 的 loader 错误已经转换为 SSR 匹配状态，不会再从 fetch 抛出。
const startHandler = createStartHandler((context) => {
  for (const match of context.router.stores.matches.get()) {
    if (match.status === 'error') captureServerError(match.error)
  }
  return defaultStreamHandler(context)
})

const worker = instrumentWeb({
  fetch(request, env) {
    const invalid = checkEnv(env)
    if (invalid) return Promise.resolve(invalid)
    if (new URL(request.url).pathname === SENTRY_TEST_PATH)
      return sentryTest(request, getWebRuntime())
    return logged(
      request,
      async () =>
        gatePublicApiRequest(request, templateConfig) ??
        (await localized(gateLocaleRequest(await gateAdminRequest(request, getWebRuntime())))),
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>)

export default {
  fetch(request, env, ctx) {
    // 不信任入站的 x-request-id：可被客户端伪造，且会混入他人的检索结果
    const requestMeta = createCloudflareRequestMetadata(request)
    const context = { requestId: requestMeta.requestId, cfRay: requestMeta.cfRay }
    const nonce = crypto.randomUUID()
    const security = {
      https: new URL(request.url).protocol === 'https:',
      nonce,
      r2AccountId: env.R2_ACCOUNT_ID,
      sentryDsn: env.SENTRY_DSN,
      analyticsOrigin: plausibleSite(templateConfig.features.analytics, env)?.origin,
      clarity: Boolean(templateConfig.analytics.clarityProjectId.trim()),
    }
    return withSecurityNonce(nonce, () =>
      withLogContext(context, async () => {
        try {
          const invalid = checkEnv(env)
          if (!invalid && (request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
            const asset = await env.ASSETS.fetch(request)
            if (asset.status !== 404) {
              const response = await withStaticSecurityHeaders(asset, security)
              response.headers.set('x-request-id', context.requestId)
              return response
            }
            await asset.body?.cancel()
          }
          const response =
            invalid ??
            (await withWebRuntime(createCloudflareWebRuntime(env, requestMeta, ctx), () =>
              worker.fetch(request, env, ctx),
            ))
          // 重定向与静态响应的 headers 可能只读，复制后再附请求 ID。
          const headers = withSecurityHeaders(response.headers, security)
          headers.set('x-request-id', context.requestId)
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        } catch (error) {
          // 包装器已经捕获异常；返回无敏感细节的响应与请求 ID，便于管理员验收定位。
          log.error('http.unhandled', { error })
          if (error instanceof AppError) {
            const { status, body } = toErrorResponse(error)
            return Response.json(body, {
              status,
              headers: withSecurityHeaders({ 'x-request-id': context.requestId }, security),
            })
          }
          return new Response('Internal Server Error', {
            status: 500,
            headers: withSecurityHeaders({ 'x-request-id': context.requestId }, security),
          })
        }
      }),
    )
  },
} satisfies ExportedHandler<Cloudflare.Env>

// 只记录方法与路径：查询串可能带令牌（魔法链接、重置密码等）
async function logged(request: Request, handle: () => Promise<Response>): Promise<Response> {
  const started = Date.now()
  const { method } = request
  const path = new URL(request.url).pathname
  try {
    const handled = await handle()
    const response = isPublicApiPath(path) ? await normalizePublicApiNotFound(handled) : handled
    log.info('http.request', {
      method,
      path: redactUrlPath(path),
      status: response.status,
      durationMs: Date.now() - started,
    })
    return response
  } catch (error) {
    log.error('http.request', {
      method,
      path: redactUrlPath(path),
      status: error instanceof AppError ? error.status : 500,
      durationMs: Date.now() - started,
      error,
    })
    throw error
  }
}

// 交给 TanStack Start 的仍是原始地址，语言前缀由路由器的 rewrite 去掉（与 SSR 后的客户端一致）
function localized(request: Request): Promise<Response> {
  return localizeRequest(request, getWebRuntime(), () => startHandler(request))
}

/** Workers 的默认 Cache API；web 的 tsconfig 同时含 DOM 声明，`caches.default` 在此显式取用。 */
function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default
}

/** CF bindings 仅在入口装配；getter 保证公开页降级时不提前创建认证/数据库资源。 */
function createCloudflareWebRuntime(
  env: Cloudflare.Env,
  requestMeta: RequestMetadata,
  ctx: ExecutionContext,
): WebRuntime {
  const config = {
    ...parseAuthEnv(env, templateConfig),
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
    PLAUSIBLE_DOMAIN: env.PLAUSIBLE_DOMAIN,
    PLAUSIBLE_HOST: env.PLAUSIBLE_HOST,
    PLAUSIBLE_SITES: env.PLAUSIBLE_SITES,
    INDEXNOW_KEY: env.INDEXNOW_KEY,
    PAYMENT_MODE: env.PAYMENT_MODE,
    SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
    AI_FAULT_INJECTION: env.AI_FAULT_INJECTION,
    UI_PREVIEW: env.UI_PREVIEW,
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
  const databases = createCloudflareDatabase(env)
  const files = createCloudflareStorage(env)
  const cache = createCloudflareKv(env.CACHE)
  const rateLimiter = createCloudflareRateLimiter(env)
  const queue = createCloudflareQueue(env.EMAIL_QUEUE)
  const workersAi = env.AI
  const createAuth = (db: Database, authCache: KeyValueStore = cache) => {
    const queued = createQueueAuthEmailSender({
      queue,
      appName: templateConfig.app.name,
      appUrl: config.APP_URL,
      resolveLocale: userLocaleByEmail(db),
    })
    // 本地调试行为与旧接线一致；生产队列消息不写入日志。
    const sendEmail: SendAuthEmail = import.meta.env.DEV
      ? async (email: AuthEmail) => {
          console.log('[dev] auth email', email)
          await queued(email)
        }
      : queued
    return createWebAuth(config, db, {
      cache: authCache,
      rateLimiter,
      clientIp: requestMeta.clientIp,
      sendEmail,
      ...(files.shareCards && {
        cleanupShareCards: createShareCardInvalidator(files.shareCards, cache)
          .cleanupWorkspaceShareCards,
      }),
      deletionSteps: createBillingDeletionSteps(config, db, cache),
      onUserSignedUp: createSignUpRecorder({
        db,
        queue: env.EVENTS_QUEUE && createCloudflareQueue(env.EVENTS_QUEUE),
        clientIp: requestMeta.clientIp,
      }),
      beforeUserCreate: async (user, headers) => {
        try {
          await assertSignupAdmission(
            {
              db,
              config: templateConfig,
              secret: config.BETTER_AUTH_SECRET,
            },
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
  }
  let auth: ReturnType<typeof createAuth> | undefined
  const textConfig = loadEnv(env, webEnvSchema)
  const runtime: WebRuntime = {
    config,
    cache,
    rateLimiter,
    requestMeta,
    observability: { enabled: sentryEnabled(env), captureError: captureServerError },
    files: { available: true, value: files },
    transferWorkflow: env.WORKSPACE_TRANSFER_WORKFLOW
      ? { available: true, value: createCloudflareWorkflow(env.WORKSPACE_TRANSFER_WORKFLOW) }
      : { available: false },
    // 渲染器只在分享卡片路由首次调用时加载；首页与其他路由的闭包不含 satori / resvg / 字体
    shareCardRenderer: env.ASSETS
      ? {
          available: true,
          value: () =>
            import('./server/cloudflare/share-card-renderer.ts').then((module) =>
              module.workersShareCardRenderer(env.ASSETS),
            ),
        }
      : { available: false },
    // 分享卡片的数据中心级缓存；写入放进 waitUntil，不阻塞本次响应。
    shareCardCache: {
      available: true,
      value: {
        match: (url) => edgeCache().match(url),
        put: async (url, response) => {
          ctx.waitUntil(edgeCache().put(url, response))
        },
      },
    },
    emailQueue: { available: true, value: queue },
    eventsQueue: env.EVENTS_QUEUE
      ? { available: true, value: createCloudflareQueue(env.EVENTS_QUEUE) }
      : { available: false },
    ai: {
      available: true,
      value: {
        config: {
          AI_FAULT_INJECTION: env.AI_FAULT_INJECTION,
          SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
          AI_TEXT_EGRESS: textConfig.AI_TEXT_EGRESS ?? 'gateway',
          OPENAI_BASE_URL: textConfig.OPENAI_BASE_URL,
          AI_GATEWAY_ACCOUNT_ID: env.AI_GATEWAY_ACCOUNT_ID,
          AI_GATEWAY_ID: env.AI_GATEWAY_ID,
          AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
          GOOGLE_API_KEY: env.GOOGLE_API_KEY,
          DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
          ...(env.FAL_KEY === undefined ? {} : { FAL_KEY: env.FAL_KEY }),
          ...(env.MEDIA_WEBHOOK_SECRET === undefined
            ? {}
            : { MEDIA_WEBHOOK_SECRET: env.MEDIA_WEBHOOK_SECRET }),
        },
        workersAi: workersAi
          ? { available: true, value: { run: (model, params) => workersAi.run(model, params) } }
          : { available: false },
        background: createCloudflareBackgroundTasks(ctx),
        workflow: env.AI_MEDIA_WORKFLOW
          ? { available: true, value: createCloudflareWorkflow(env.AI_MEDIA_WORKFLOW) }
          : { available: false },
        downloadFile: {
          available: true,
          value: (input) => getFileDownload(databases.business(), files, input),
        },
      },
    },
    get db() {
      return databases.business()
    },
    get publicDb() {
      return databases.public()
    },
    get auth() {
      auth ??= createAuth(databases.business())
      return auth
    },
    createAuth,
    handleAuthRequest: (request) => handleAuthRequest(request, runtime),
  }
  return runtime
}
