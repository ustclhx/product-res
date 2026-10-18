import { AppError } from '@product-res/shared'
import { withLogContext } from '@product-res/shared/log'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wrap: vi.fn((_, handler) => handler),
  capture: vi.fn(),
  client: true,
}))
vi.mock('@sentry/cloudflare', () => ({
  withSentry: mocks.wrap,
  captureException: mocks.capture,
  getClient: () => (mocks.client ? {} : undefined),
}))

import { captureServerError, instrumentWeb, sentryOptions } from './sentry.ts'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mocks.client = true
})

it('真实 DSN 在本地也不包装或初始化 SDK，部署环境才启用', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response('ok')))
  const handler = instrumentWeb({ fetch })
  const request = new Request('https://app.test') as Parameters<typeof handler.fetch>[0]
  const ctx = {} as ExecutionContext
  await handler.fetch(
    request,
    { SENTRY_DSN: 'fixture', SENTRY_ENVIRONMENT: 'development' } as Cloudflare.Env,
    ctx,
  )
  await handler.fetch(request, { SENTRY_ENVIRONMENT: 'staging' } as Cloudflare.Env, ctx)
  expect(mocks.wrap).not.toHaveBeenCalled()
  await handler.fetch(
    request,
    { SENTRY_DSN: 'fixture', SENTRY_ENVIRONMENT: 'staging' } as Cloudflare.Env,
    ctx,
  )
  const smokeHandler = instrumentWeb({ fetch })
  await smokeHandler.fetch(
    request,
    { SENTRY_DSN: 'fixture', SENTRY_ENVIRONMENT: 'smoke' } as Cloudflare.Env,
    ctx,
  )
  expect(mocks.wrap).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(4)
  vi.stubGlobal('__APP_VERSION__', 'full-deployment-sha')
  expect(sentryOptions({} as Cloudflare.Env)).toMatchObject({
    release: 'full-deployment-sha',
    dist: 'web',
    tracesSampleRate: 0,
  })
})

it('框架捕获的异常附当前请求身份，预期业务错误与本地错误不发送', () => {
  captureServerError(new AppError('DENIED', 'Denied', { status: 403 }))
  mocks.client = false
  captureServerError(new Error('local'))
  expect(mocks.capture).not.toHaveBeenCalled()
  mocks.client = true
  const error = new Error('unexpected server function error')
  withLogContext({ requestId: 'request-1', userId: 'user-1' }, () => captureServerError(error))
  expect(mocks.capture).toHaveBeenCalledWith(error, {
    tags: { requestId: 'request-1', userId: 'user-1', workspaceId: undefined },
  })
})
