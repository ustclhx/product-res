import { AppError } from '@product-res/shared'
import { type LogContext, withLogContext } from '@product-res/shared/log'
import type { initializeNodeObservability } from './observability.ts'

export type NodeWebObserver = Omit<
  Awaited<ReturnType<typeof initializeNodeObservability>>,
  'captureError'
> & {
  captureError(
    error: unknown,
    context?: LogContext,
    businessError?: { code: string; status: number },
  ): void
}

/** AppError 的 instanceof 必须在产生错误的 bundle 内检查，跨 bundle 只传受信任摘要。 */
export function captureNodeError(
  observer: Pick<NodeWebObserver, 'captureError'>,
  error: unknown,
  context: LogContext,
) {
  observer.captureError(
    error,
    context,
    error instanceof AppError ? { code: error.code, status: error.status } : undefined,
  )
}

/** bootstrap、Nitro、Start 各有 log ALS；调用点显式传身份快照，不在全局保存身份。 */
export function bridgeNodeObserver(
  observer: Awaited<ReturnType<typeof initializeNodeObservability>>,
): NodeWebObserver {
  const businessErrors = new WeakMap<object, AppError>()
  return {
    ...observer,
    captureError(error, context = {}, businessError) {
      if (businessError && typeof error === 'object' && error !== null) {
        let normalized = businessErrors.get(error)
        if (!normalized) {
          normalized = new AppError(businessError.code, '', { status: businessError.status })
          if (error instanceof Error && error.stack !== undefined) normalized.stack = error.stack
          businessErrors.set(error, normalized)
        }
        error = normalized
      }
      withLogContext(context, () => observer.captureError(error))
    },
  }
}
