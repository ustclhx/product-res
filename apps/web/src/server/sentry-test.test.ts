import { AppError } from '@product-res/shared'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), audit: vi.fn(), action: vi.fn(), enabled: true }))
vi.mock('../features/admin/guard.ts', () => ({
  requireAdmin: mocks.admin,
  isAdminNotFound: (error: unknown) => error instanceof AppError && error.status === 404,
}))
vi.mock('../features/admin/action.server.ts', () => ({
  withAdminAction: async (
    context: unknown,
    _name: string,
    handler: (scope: unknown) => Promise<void>,
  ) => {
    mocks.action(context)
    await handler({ audit: mocks.audit })
  },
}))

import type { WebRuntime } from './runtime.ts'
import { SENTRY_TEST_PATH, sentryTest } from './sentry-test.ts'

const runtime = {
  config: { APP_URL: 'https://app.test' },
  db: {},
  auth: {},
  requestMeta: { clientIp: 'trusted-peer' },
  observability: {
    get enabled() {
      return mocks.enabled
    },
  },
} as unknown as WebRuntime
const request = (origin = runtime.config.APP_URL) =>
  new Request(`${runtime.config.APP_URL}${SENTRY_TEST_PATH}`, {
    method: 'POST',
    headers: { origin, 'cf-connecting-ip': 'forged-ip' },
  })
afterEach(() => {
  vi.clearAllMocks()
  mocks.enabled = true
})

it('外站与非管理员不能触发异常或审计', async () => {
  expect((await sentryTest(request('https://attacker.test'), runtime)).status).toBe(403)
  expect(mocks.admin).not.toHaveBeenCalled()
  mocks.admin.mockRejectedValueOnce(new AppError('NOT_FOUND', 'Not Found', { status: 404 }))
  expect((await sentryTest(request(), runtime)).status).toBe(404)
  expect(mocks.audit).not.toHaveBeenCalled()
})

it('管理员触发前提交审计，未启用时不抛测试异常', async () => {
  mocks.admin.mockResolvedValue({ user: { id: 'admin-1' } })
  mocks.enabled = false
  expect((await sentryTest(request(), runtime)).status).toBe(503)
  expect(mocks.audit).not.toHaveBeenCalled()
  mocks.enabled = true
  await expect(sentryTest(request(), runtime)).rejects.toThrow(
    'Sentry verification: web worker test exception',
  )
  expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ ip: 'trusted-peer' }))
  expect(mocks.audit).toHaveBeenCalledWith({
    action: 'observability.sentry-test',
    targetType: 'observability',
  })
})
