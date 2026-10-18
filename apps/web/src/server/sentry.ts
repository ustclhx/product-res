import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { isNotFound, isRedirect } from '@tanstack/react-router'
import { getWebRuntime } from './runtime.ts'

/** Start 序列化异常前通知入口注入的观测能力，避免共享中间件加载 CF SDK。 */
export function captureServerError(error: unknown): void {
  if (isNotFound(error) || isRedirect(error)) return
  if (error instanceof AppError && error.status < 500) return
  const observer = getWebRuntime().observability
  if (observer) observer.captureError(error)
  else log.error('http.server_error', { error })
}
