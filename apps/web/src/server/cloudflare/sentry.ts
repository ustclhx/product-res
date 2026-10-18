import { AppError } from '@product-res/shared'
import { getLogContext, sentryBeforeSend } from '@product-res/shared/log'
import { type CloudflareOptions, captureException, getClient, withSentry } from '@sentry/cloudflare'
import { isNotFound, isRedirect } from '@tanstack/react-router'

export function sentryEnabled(env: Pick<Cloudflare.Env, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT'>) {
  return Boolean(
    env.SENTRY_DSN &&
      (env.SENTRY_ENVIRONMENT === 'staging' ||
        env.SENTRY_ENVIRONMENT === 'production' ||
        env.SENTRY_ENVIRONMENT === 'smoke'),
  )
}

export function sentryOptions(env: Cloudflare.Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: __APP_VERSION__,
    dist: 'web',
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    beforeSend: sentryBeforeSend,
  }
}

/** 没有 DSN 或本地环境时连 SDK 初始化也跳过；withSentry 会原地修改 handler，必须复制。 */
type WebHandler = { fetch: NonNullable<ExportedHandler<Cloudflare.Env>['fetch']> }

export function instrumentWeb(handler: WebHandler): WebHandler {
  let instrumented: WebHandler | undefined
  return {
    ...handler,
    fetch(request, env, ctx) {
      if (!sentryEnabled(env)) return handler.fetch(request, env, ctx)
      instrumented ??= withSentry(sentryOptions, { ...handler })
      return instrumented.fetch(request, env, ctx)
    },
  }
}

/** Start 会把 server function 错误序列化为响应，须在框架吞掉异常前采集。 */
export function captureServerError(error: unknown): void {
  if (!getClient() || isNotFound(error) || isRedirect(error)) return
  if (error instanceof AppError && error.status < 500) return
  const { requestId, workspaceId, userId } = getLogContext()
  captureException(error, { tags: { requestId, workspaceId, userId } })
}
