import { env } from 'cloudflare:workers'
import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import { createCloudflareKv } from '@product-res/platform/cloudflare'
import { newId } from '@product-res/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CreateAuthDeps, createAuth } from '../src/auth.ts'
import type { AuthEmail } from '../src/email.ts'
import {
  APP_URL,
  app,
  cookieHeader,
  signUpBody,
  silenceExpectedErrors,
  testEnv,
  testUsers,
} from './helpers.ts'

const users = testUsers('signup-bonus-hook')
afterEach(() => vi.restoreAllMocks())
afterAll(() => users.cleanup())
beforeEach(() => users.start())

function setup(callback: NonNullable<CreateAuthDeps['onEmailVerified']>) {
  const db = createDb(env.HYPERDRIVE)
  const sent: AuthEmail[] = []
  const auth = createAuth(testEnv, db, {
    cache: createCloudflareKv(env.CACHE),
    config: defineTemplateConfig({ app, auth: { turnstile: false } }),
    sendEmail: async (message) => {
      sent.push(message)
    },
    onEmailVerified: callback,
  })
  const post = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: 'POST',
        headers: {
          origin: APP_URL,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    )
  return { auth, db, sent, post }
}

describe('injected signup bonus hook', () => {
  it('runs on a real verification link after the verified DB flag and workspace exist, never on unverified signup or replay', async () => {
    const address = users.email('verified')
    const callback = vi.fn(async (user: { id: string; email: string }) => {
      expect(user.email).toBe(address)
      expect(
        await s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, user.id) }),
      ).toMatchObject({ emailVerified: true })
      expect(
        await s.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, user.id) }),
      ).toMatchObject({ isPersonal: true })
    })
    const s = setup(callback)
    const signup = await s.post('/sign-up/email', signUpBody(address))
    expect(signup.status).toBe(200)
    expect(callback).not.toHaveBeenCalled()
    expect(
      (
        await s.post(
          '/send-verification-email',
          { email: address, callbackURL: '/app' },
          cookieHeader(signup),
        )
      ).status,
    ).toBe(200)
    const mail = s.sent.find((m) => m.type === 'verify-email')
    if (mail?.type !== 'verify-email') throw new Error('Verification email missing')
    expect((await s.auth.handler(new Request(mail.url))).status).toBe(302)
    expect(callback).toHaveBeenCalledTimes(1)
    expect((await s.auth.handler(new Request(mail.url))).status).toBe(302)
    expect(callback).toHaveBeenCalledTimes(1)
  })
  it('runs once after mocked OAuth verified-user registration creates its personal workspace and preserves session defaults', async () => {
    const callback = vi.fn(async (user: { id: string; email: string }) => {
      expect(
        await s.db.query.member.findFirst({
          where: (m, { and, eq }) => and(eq(m.userId, user.id), eq(m.organizationId, user.id)),
        }),
      ).toMatchObject({ role: 'owner' })
    })
    const s = setup(callback)
    const context = await s.auth.$context
    const registered = await context.internalAdapter.createOAuthUser(
      { email: users.email('oauth'), name: 'OAuth', emailVerified: true },
      { providerId: 'google', accountId: newId() },
    )
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      id: registered.user.id,
      email: registered.user.email,
    })
    const session = await context.internalAdapter.createSession(registered.user.id)
    expect(
      await s.db.query.session.findFirst({ where: (row, { eq }) => eq(row.id, session?.id ?? '') }),
    ).toMatchObject({ activeOrganizationId: registered.user.id })
    expect(callback).toHaveBeenCalledTimes(1)
    await context.internalAdapter.createOAuthUser(
      { email: users.email('oauth-unverified'), name: 'OAuth', emailVerified: false },
      { providerId: 'google', accountId: newId() },
    )
    expect(callback).toHaveBeenCalledTimes(1)
  })
  it('propagates grant failures after verification remains committed for an authenticated claim retry', async () => {
    silenceExpectedErrors(/Grant database unavailable/)
    const callback = vi.fn(async () => {
      throw new Error('Grant database unavailable')
    })
    const s = setup(callback)
    const address = users.email('failure')
    const signup = await s.post('/sign-up/email', signUpBody(address))
    await s.post('/send-verification-email', { email: address }, cookieHeader(signup))
    const mail = s.sent.find((m) => m.type === 'verify-email')
    if (mail?.type !== 'verify-email') throw new Error('Verification email missing')
    const failed = await s.auth.handler(new Request(mail.url))
    expect(failed.status).toBe(500)
    expect(
      await s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, address) }),
    ).toMatchObject({ emailVerified: true })
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
