import { env } from 'cloudflare:workers'
import { createDb, type Database } from '@product-res/db'
import { newId } from '@product-res/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { adminBootstrap } from '../src/admin-bootstrap.ts'
import { cookieHeader, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('admin-bootstrap')
afterAll(() => users.cleanup())
const configured = (emails?: string, magicLink = false) =>
  setup({
    config: { auth: { turnstile: false, magicLink } },
    env: { BOOTSTRAP_ADMIN_EMAILS: emails },
    rateLimiter: undefined,
  })
const readUser = async (s: ReturnType<typeof setup>, email: string) => {
  const user = await s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, email) })
  if (!user) throw new Error('Expected test user missing')
  return user
}
const audits = (s: ReturnType<typeof setup>, id: string) =>
  s.db.query.auditLog.findMany({
    where: (a, { and, eq }) => and(eq(a.targetId, id), eq(a.action, 'admin.user.bootstrap')),
  })

async function oauth(s: ReturnType<typeof setup>, email: string, verified = true) {
  const context = await s.auth.$context
  return context.internalAdapter.createOAuthUser(
    { email, name: 'OAuth', emailVerified: verified },
    { providerId: 'google', accountId: newId() },
  )
}

describe('first-run administrator bootstrap', () => {
  it('promotes a verified OAuth creation with normalized configuration and keeps its personal workspace', async () => {
    const address = users.email('oauth')
    const s = configured(` , ${address.toUpperCase()} , ${address} , `)
    const { user } = await oauth(s, address)
    expect(await readUser(s, address)).toMatchObject({ role: 'admin', emailVerified: true })
    expect(
      await s.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, user.id) }),
    ).toMatchObject({ isPersonal: true })
    expect(await audits(s, user.id)).toMatchObject([
      {
        actorUserId: null,
        targetType: 'user',
        meta: { trigger: 'user.create', before: { role: 'user' }, after: { role: 'admin' } },
      },
    ])
  })

  it('waits for a real password email verification and records only one promotion on link replay', async () => {
    const address = users.email('password')
    const s = configured(address)
    const signup = await s.post('/sign-up/email', signUpBody(address))
    expect(signup.status).toBe(200)
    expect(await readUser(s, address)).toMatchObject({ role: 'user', emailVerified: false })
    expect(
      (
        await s.post(
          '/send-verification-email',
          { email: address },
          { cookie: cookieHeader(signup) },
        )
      ).status,
    ).toBe(200)
    const mail = s.sent.find((m) => m.type === 'verify-email')
    if (mail?.type !== 'verify-email') throw new Error('Verification mail missing')
    expect((await s.auth.handler(new Request(mail.url))).status).toBe(302)
    expect((await s.auth.handler(new Request(mail.url))).status).toBe(302)
    const user = await readUser(s, address)
    expect(user).toMatchObject({ role: 'admin', emailVerified: true })
    expect(await audits(s, user.id)).toMatchObject([{ meta: { trigger: 'user.update' } }])
  })

  it.each(['otp', 'magic-link'] as const)(
    'promotes an existing unverified account after %s verifies it',
    async (method) => {
      const address = users.email(method)
      const s = configured(address, true)
      expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
      if (method === 'otp') {
        expect(
          (await s.post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' }))
            .status,
        ).toBe(200)
        const mail = s.sent.find((m) => m.type === 'otp')
        if (mail?.type !== 'otp') throw new Error('OTP missing')
        expect((await s.post('/sign-in/email-otp', { email: address, otp: mail.otp })).status).toBe(
          200,
        )
      } else {
        expect((await s.post('/sign-in/magic-link', { email: address })).status).toBe(200)
        const mail = s.sent.find((m) => m.type === 'magic-link')
        if (mail?.type !== 'magic-link') throw new Error('Magic link missing')
        expect((await s.auth.handler(new Request(mail.url))).status).toBe(302)
      }
      const user = await readUser(s, address)
      expect(user).toMatchObject({ role: 'admin', emailVerified: true })
      expect(await audits(s, user.id)).toMatchObject([{ meta: { trigger: 'user.update' } }])
    },
  )

  it('promotes an existing verified account on login, stays idempotent, and never demotes when removed', async () => {
    const address = users.email('existing')
    const initial = configured()
    expect((await initial.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    await initial.db.$client`update "user" set email_verified = true where email = ${address}`
    const s = configured(address)
    const login = () => s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect((await login()).status).toBe(200)
    const promoted = await readUser(s, address)
    expect(promoted?.role).toBe('admin')
    expect((await login()).status).toBe(200)
    expect(
      (await initial.post('/sign-in/email', { email: address, password: PASSWORD })).status,
    ).toBe(200)
    expect(await readUser(s, address)).toMatchObject({
      role: 'admin',
      updatedAt: promoted.updatedAt,
    })
    expect(await audits(s, promoted.id)).toMatchObject([{ meta: { trigger: 'session.create' } }])
  })

  it('rejects unverified, unlisted, banned (even expired), and disabled candidates; existing admins stay unchanged', async () => {
    const initial = configured()
    const addresses = ['unverified', 'unlisted', 'banned', 'admin', 'disabled'].map(users.email)
    for (const [index, address] of addresses.entries()) {
      const { user } = await oauth(initial, address, index !== 0)
      if (index === 2)
        await initial.db
          .$client`update "user" set banned = true, ban_expires = now() - interval '1 day' where id = ${user.id}`
      if (index === 3)
        await initial.db.$client`update "user" set role = 'admin' where id = ${user.id}`
    }
    const s = configured(addresses.filter((_, i) => i !== 1).join(','))
    const context = await s.auth.$context
    for (const [index, address] of addresses.entries()) {
      const before = await readUser(s, address)
      if (index === 4) {
        for (const empty of [undefined, '', ' , , ']) {
          const disabled = configured(empty)
          await (await disabled.auth.$context).internalAdapter.createSession(before.id)
        }
      } else await context.internalAdapter.createSession(before.id)
      expect(await readUser(s, address)).toMatchObject({
        role: before.role,
        updatedAt: before.updatedAt,
      })
      expect(await audits(s, before.id)).toEqual([])
    }
  })

  it.each(['admin,user', 'user, admin ', 'user,\tadmin\n', 'user,\u00a0admin\ufeff'])(
    'preserves an existing admin role list %j on real session creation',
    async (role) => {
      const address = users.email('multi-role-admin')
      const initial = configured()
      const { user } = await oauth(initial, address)
      await initial.db.$client`update "user" set role = ${role} where id = ${user.id}`
      const before = await readUser(initial, address)
      const s = configured(address)
      const context = await s.auth.$context
      await context.internalAdapter.createSession(user.id)
      expect(await readUser(s, address)).toMatchObject({ role, updatedAt: before.updatedAt })
      expect(await audits(s, user.id)).toEqual([])
    },
  )

  it('normalizes the persisted email and permits only one audit under concurrent real session hooks', async () => {
    const address = users.email('concurrent')
    const initial = configured()
    const { user } = await oauth(initial, address)
    await initial.db
      .$client`update "user" set email = ${` ${address.toUpperCase()} `} where id = ${user.id}`
    const s = configured(address)
    const context = await s.auth.$context
    await Promise.all(
      Array.from({ length: 4 }, () => context.internalAdapter.createSession(user.id)),
    )
    expect(
      await s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, user.id) }),
    ).toMatchObject({ role: 'admin' })
    expect(await audits(s, user.id)).toHaveLength(1)
    // 清理仍按本文件独占域名匹配。
    await s.db.$client`update "user" set email = ${address} where id = ${user.id}`
  })

  it.each([false, true])(
    'uses an outer Drizzle transaction for session promotion (rollback=%s)',
    async (rollback) => {
      const address = users.email('outer-transaction')
      const initial = configured()
      const { user } = await oauth(initial, address)
      const transaction = initial.db.transaction(async (tx) => {
        const s = setup({
          db: tx as unknown as Database,
          config: { auth: { turnstile: false } },
          env: { BOOTSTRAP_ADMIN_EMAILS: address },
          cache: undefined,
          rateLimiter: undefined,
        })
        const context = await s.auth.$context
        await context.internalAdapter.createSession(user.id)
        expect(await readUser(s, address)).toMatchObject({ role: 'admin' })
        expect(await audits(s, user.id)).toHaveLength(1)
        if (rollback) throw new Error('Outer transaction failed')
      })
      if (rollback) await expect(transaction).rejects.toThrow('Outer transaction failed')
      else await transaction
      expect(await readUser(initial, address)).toMatchObject({ role: rollback ? 'user' : 'admin' })
      expect(await audits(initial, user.id)).toHaveLength(rollback ? 0 : 1)
    },
  )

  it('rolls back promotion and propagates an audit failure', async () => {
    const address = users.email('audit-failure')
    const s = configured()
    const { user } = await oauth(s, address)
    const failingDb = new Proxy(s.db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver)
        return (callback: Parameters<Database['transaction']>[0]) =>
          target.transaction(async (tx) =>
            callback(
              new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === 'insert')
                    return () => {
                      throw new Error('Audit write failed')
                    }
                  return Reflect.get(txTarget, txProperty, txReceiver)
                },
              }),
            ),
          )
      },
    })
    await expect(adminBootstrap(failingDb, address)(user.id, 'session.create')).rejects.toThrow(
      'Audit write failed',
    )
    expect(await readUser(s, address)).toMatchObject({ role: 'user' })
    expect(await audits(s, user.id)).toEqual([])
    await adminBootstrap(createDb(env.HYPERDRIVE), address)(user.id, 'session.create')
    expect(await readUser(s, address)).toMatchObject({ role: 'admin' })
  })
})
