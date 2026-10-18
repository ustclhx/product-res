import { AppError } from '@product-res/shared'
import { expect, it, vi } from 'vitest'
import { withEntitlement, withWorkspace } from '../../../apps/web/src/server/middleware.ts'
import { DEFAULT_FREE_FEATURES, UPGRADE_REQUIRED } from '../src/index.ts'

// 这些用例验证启用模块的权益行为；关闭模块的 404/无 seed 行为由 web feature-gates 用例覆盖。
vi.mock('../../../apps/web/src/server/template-config.ts', async (original) => {
  const { templateConfig } =
    await original<typeof import('../../../apps/web/src/server/template-config.ts')>()
  return {
    templateConfig: {
      ...templateConfig,
      billing: { ...templateConfig.billing, enabled: true },
      credits: { ...templateConfig.credits, enabled: true },
    },
  }
})

vi.mock('../../../apps/web/src/server/auth.ts', () => ({ getAuth: vi.fn() }))
vi.mock('@product-res/entitlements', async (original) => ({
  ...(await original<typeof import('../src/index.ts')>()),
  getEntitlements: vi.fn(async () => ({ key: 'free', sort: 0, features: DEFAULT_FREE_FEATURES })),
}))

const context = {
  db: {},
  user: { id: 'actor' },
  workspace: { id: 'workspace' },
  member: { role: 'owner' },
  workspaceReadOnly: false,
}

it('middleware chains fresh workspace authorization and rejects a paid model with upgrade code', async () => {
  const middleware = withEntitlement({ capability: 'ai.useModel', modelKey: 'premium' })
  expect(middleware.options.middleware).toEqual([withWorkspace])
  const next = vi.fn()
  const result = middleware.options.server?.({ context, data: {}, next } as never)
  await expect(result).rejects.toBeInstanceOf(AppError)
  await expect(result).rejects.toMatchObject({ code: UPGRADE_REQUIRED, status: 403 })
  expect(next).not.toHaveBeenCalled()
})

it('middleware keeps read-only team writes blocked before evaluating entitlements', async () => {
  const middleware = withEntitlement({ limit: 'maxSeats', value: 1 })
  await expect(
    middleware.options.server?.({
      context: { ...context, workspaceReadOnly: true },
      data: {},
      next: vi.fn(),
    } as never),
  ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' })
})

it('middleware permits an entitled read and injects request entitlements', async () => {
  const next = vi.fn(async (value) => value)
  const middleware = withEntitlement({ limit: 'maxSeats', value: 1 }, { access: 'read' })
  await middleware.options.server?.({
    context: { ...context, workspaceReadOnly: true },
    data: {},
    next,
  } as never)
  expect(next).toHaveBeenCalledWith({
    context: {
      entitlements: { key: 'free', sort: 0, features: DEFAULT_FREE_FEATURES },
    },
  })
})
