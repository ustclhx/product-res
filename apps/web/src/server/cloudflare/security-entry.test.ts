import { AppError } from '@product-res/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkEnv: vi.fn(),
  start: vi.fn(),
  capture: vi.fn(),
  meta: { requestId: 'server-generated-request-id', clientIp: '198.51.100.1' },
}))
vi.mock('@tanstack/react-start/server', () => ({
  createStartHandler: () => mocks.start,
  defaultStreamHandler: vi.fn(),
}))
vi.mock('@product-res/platform/cloudflare', () => ({ createCloudflareRequestMetadata: () => mocks.meta }))
vi.mock('../../server/cloudflare/env.ts', () => ({ checkEnv: mocks.checkEnv }))
vi.mock('../../server/cloudflare/sentry.ts', () => ({
  instrumentWeb: (handler: unknown) => handler,
  captureServerError: mocks.capture,
}))
vi.mock('../../node/request-runtime.ts', () => ({
  requestWebRuntime: () => ({
    requestMeta: mocks.meta,
    observability: { captureError: mocks.capture },
  }),
}))
vi.mock('../../features/admin/gate.ts', () => ({ gateAdminRequest: (request: Request) => request }))
vi.mock('../../features/api-keys/gate.ts', () => ({
  gatePublicApiRequest: () => null,
  isPublicApiPath: () => false,
}))
vi.mock('../../features/i18n/gate.ts', () => ({ gateLocaleRequest: (request: Request) => request }))
vi.mock('../../features/i18n/request.server.ts', () => ({
  localizeRequest: (_request: unknown, _runtime: unknown, next: () => unknown) => next(),
}))

import node from '../../server.node.ts'
import cloudflare from '../../server.ts'

afterEach(() => vi.resetAllMocks())

function assertHeaders(response: Response, https: boolean) {
  expect(response.headers.get('x-request-id')).toBe(mocks.meta.requestId)
  expect(response.headers.get('x-frame-options')).toBe('DENY')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  expect(response.headers.has('strict-transport-security')).toBe(https)
  expect(response.headers.get('content-security-policy-report-only')).toContain(
    "frame-ancestors 'none'",
  )
}

describe.each(['cloudflare', 'node'] as const)('%s 响应入口安全头', (target) => {
  const call = (https = true) => {
    const request = new Request(`${https ? 'https' : 'http'}://example.test/login`, {
      headers: { 'x-request-id': 'forged' },
    })
    return target === 'node'
      ? node.fetch(request)
      : cloudflare.fetch(
          request as Parameters<typeof cloudflare.fetch>[0],
          {} as Cloudflare.Env,
          {} as ExecutionContext,
        )
  }
  it('只读重定向补头并保留 Location', async () => {
    const response = Response.redirect('https://example.test/next')
    mocks.start.mockResolvedValue(response)
    mocks.checkEnv.mockReturnValue(response)
    const result = await call(false)
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('https://example.test/next')
    assertHeaders(result, false)
    expect(response.headers.has('x-frame-options')).toBe(false)
  })
  it('内部 AppError 顶层响应不暴露 code 或详情', async () => {
    const error = new AppError('PRIVATE_CREDIT_FAILURE', 'private failure', {
      status: 503,
      publicDetails: { secret: 'private' },
      expose: false,
    })
    mocks.start.mockRejectedValue(error)
    mocks.checkEnv.mockImplementation(() => {
      throw error
    })
    const response = await call()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
    })
    // Cloudflare 的 instrumentWeb 在此测试中为透传；上报由独立 Sentry 测试验证。
    if (target === 'node') expect(mocks.capture).toHaveBeenCalledWith(error)
    assertHeaders(response, true)
  })
  it.each([new Error('private failure'), new AppError('DENIED', 'Denied', { status: 403 })])(
    '异常响应仍带安全头及可信请求 ID',
    async (error) => {
      mocks.start.mockRejectedValue(error)
      mocks.checkEnv.mockImplementation(() => {
        throw error
      })
      const response = await call()
      expect(response.status).toBe(error instanceof AppError ? 403 : 500)
      assertHeaders(response, true)
      expect(await response.text()).not.toContain('private failure')
    },
  )
})
