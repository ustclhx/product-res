import { AppError } from '@product-res/shared'
import { expect, it, vi } from 'vitest'
import { type WebRuntime, withWebRuntime } from './runtime.ts'
import { captureServerError } from './sentry.ts'

it('共享错误中间件只调用本请求的观测能力，预期业务错误不采集', () => {
  const captureError = vi.fn()
  const runtime = { observability: { enabled: true, captureError } } as unknown as WebRuntime
  const error = new Error('unexpected')
  withWebRuntime(runtime, () => {
    captureServerError(new AppError('DENIED', 'Denied', { status: 403 }))
    captureServerError(error)
  })
  expect(captureError).toHaveBeenCalledExactlyOnceWith(error)
})
