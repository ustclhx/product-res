import type { CreateAuthDeps } from '@product-res/auth'
import type { Database } from '@product-res/db'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  template: { billing: { enabled: false }, credits: { enabled: false } },
  auth: vi.fn((_env: unknown, _db: unknown, deps: CreateAuthDeps) => deps),
  grant: vi.fn(),
}))
vi.mock('./template-config.ts', () => ({ templateConfig: mocks.template }))
vi.mock('@product-res/auth', () => ({ createAuth: mocks.auth }))
vi.mock('@product-res/billing', () => ({ grantSignupBonus: mocks.grant }))
vi.mock('@tanstack/react-start', () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}))

import { createWebAuth } from './auth.ts'
import { requireFeature } from './feature-gates.ts'
import { resolveWorkspaceMaxSeats } from './workspace-data.ts'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.template.billing.enabled = false
  mocks.template.credits.enabled = false
})

it('resolves workspace membership seats without billing plans or seed when billing is disabled', async () => {
  const sql = {
    unsafe: vi.fn(() => {
      throw new Error('Billing tables must not be read')
    }),
  }
  await expect(resolveWorkspaceMaxSeats('workspace', sql)).resolves.toBeNull()
  expect(sql.unsafe).not.toHaveBeenCalled()
})

it('keeps authentication configured and skips default credit grants after email verification', async () => {
  const deps = createWebAuth(
    { APP_URL: 'https://example.test', BETTER_AUTH_SECRET: 'fixture' },
    {} as Database,
    { sendEmail: vi.fn() },
  ) as unknown as CreateAuthDeps
  expect(deps.config).toBe(mocks.template)
  await deps.onEmailVerified?.({ id: 'user', email: 'user@example.test' })
  expect(mocks.grant).not.toHaveBeenCalled()
  mocks.template.credits.enabled = true
  await deps.onEmailVerified?.({ id: 'user', email: 'user@example.test' })
  expect(mocks.grant).toHaveBeenCalledOnce()
})

it('denies disabled billing and credits entrypoints with 404', () => {
  for (const feature of ['billing', 'credits'] as const) {
    expect(() => requireFeature(feature)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    )
    mocks.template[feature].enabled = true
    expect(() => requireFeature(feature)).not.toThrow()
  }
})
