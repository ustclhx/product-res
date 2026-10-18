import { AppError } from '@product-res/shared'
import { log, withLogContext } from '@product-res/shared/log'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { gateAdminRequest } from './features/admin/gate.ts'
import {
  gatePublicApiRequest,
  isPublicApiPath,
  normalizePublicApiNotFound,
} from './features/api-keys/gate.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { localizeRequest } from './features/i18n/request.server.ts'
import { requestWebRuntime } from './node/request-runtime.ts'
import { withWebRuntime } from './server/runtime.ts'
import { captureServerError } from './server/sentry.ts'
import { SENTRY_TEST_PATH, sentryTest } from './server/sentry-test.ts'
import { templateConfig } from './server/template-config.ts'

// Router 已把 loader 错误转换为匹配状态，需在 SSR 响应前沿用 CF 的采集点。
const startHandler = createStartHandler((context) => {
  for (const match of context.router.stores.matches.get()) {
    if (match.status === 'error') captureServerError(match.error)
  }
  return defaultStreamHandler(context)
})

export default {
  fetch(request: Request): Promise<Response> {
    const runtime = requestWebRuntime(request)
    return withLogContext(
      { requestId: runtime.requestMeta.requestId, cfRay: runtime.requestMeta.cfRay },
      () =>
        withWebRuntime(runtime, async () => {
          const started = Date.now()
          const path = new URL(request.url).pathname
          try {
            if (path === SENTRY_TEST_PATH) return await sentryTest(request, runtime)
            const gated = gatePublicApiRequest(request, templateConfig)
            const localized = gateLocaleRequest(await gateAdminRequest(request, runtime))
            const response =
              gated ?? (await localizeRequest(localized, runtime, () => startHandler(localized)))
            const result = isPublicApiPath(path)
              ? await normalizePublicApiNotFound(response)
              : response
            log.info('http.request', {
              method: request.method,
              path,
              status: result.status,
              durationMs: Date.now() - started,
            })
            return result
          } catch (error) {
            runtime.observability?.captureError(error)
            return error instanceof AppError
              ? Response.json(error.toJSON(), { status: error.status })
              : new Response('Internal Server Error', { status: 500 })
          }
        }),
    )
  },
}
