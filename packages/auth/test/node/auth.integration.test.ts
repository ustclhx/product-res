import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import { createNodeCache } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AuthEmail, createAuth, requireFreshSession } from '../../src/index.ts'

// 基础 DB/cache 集成捕获注入 sender；不宣称 B 的持久邮件队列或 Compose auth e2e 通过。
const databaseUrl = process.env.NODE_AUTH_DATABASE_URL
const migrationUrl = process.env.MIGRATION_DATABASE_URL
const cacheUrl = process.env.TEST_VALKEY_URL
if (!databaseUrl || !migrationUrl || !cacheUrl) throw new Error('Missing Node auth test resources')
const db = createDb(databaseUrl, { max: 3 })
const migrator = createDb(migrationUrl, { max: 1 })
const refused = createDb('postgres://app:app@127.0.0.1:1/db', { connect_timeout: 1 })
const appUrl = 'http://localhost:3000'
const domain = `${newId()}.node-auth.example`
const password = 'correct-horse-battery-staple'
const config = defineTemplateConfig({
  app: { name: 'Node auth test', url: appUrl, supportEmail: 'support@example.test' },
  auth: { turnstile: false, oauth: [] },
  billing: { enabled: false },
  credits: { enabled: false },
  ai: { text: { enabled: false }, image: false, video: false },
})
const scalarEnv = {
  APP_URL: appUrl,
  BETTER_AUTH_SECRET: 'node-auth-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
}
type Cache = Awaited<ReturnType<typeof createNodeCache>>
let web: Cache
let peer: Cache
const sent: AuthEmail[] = []
const address = (name: string) => `${name}-${newId()}@${domain}`

beforeAll(async () => {
  const options = {
    url: cacheUrl,
    namespace: `node-auth-test-${newId()}`,
    policies: {
      auth: { limit: 3, periodSeconds: 60 },
      ai: { limit: 20, periodSeconds: 60 },
      api: { limit: 60, periodSeconds: 60 },
    },
  }
  web = await createNodeCache(options)
  peer = await createNodeCache(options)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  try {
    const users = await db.$client<
      { id: string }[]
    >`select id from "user" where email like ${`%@${domain}`}`
    const ids = users.map((user) => user.id)
    const sessions = await db.$client<
      { token: string }[]
    >`select s.token from session s join "user" u on u.id=s.user_id where u.email like ${`%@${domain}`}`
    for (const session of sessions) await web.kv('auth').delete(`auth:${session.token}`)
    for (const id of ids) await web.kv('auth').delete(`auth:active-sessions-${id}`)
    await db.$client`delete from verification where identifier like ${`%${domain}%`} or value like ${`%${domain}%`}`
    if (ids.length) {
      await db.$client`delete from session where user_id in ${db.$client(ids)}`
      await migrator.$client`delete from audit_log where actor_user_id in ${migrator.$client(ids)} or workspace_id in ${migrator.$client(ids)}`
      await db.$client`delete from member where user_id in ${db.$client(ids)}`
      await db.$client`delete from organization where id in ${db.$client(ids)}`
      await db.$client`delete from account where user_id in ${db.$client(ids)}`
      await db.$client`delete from "user" where id in ${db.$client(ids)}`
    }
  } finally {
    await Promise.all([web?.close(), peer?.close(), db.close(), migrator.close(), refused.close()])
  }
})

function auth(cache: Cache, clientIp: string, database = db) {
  return createAuth(scalarEnv, database, {
    config,
    cache: cache.kv('auth'),
    rateLimiter: cache.rateLimiter,
    clientIp,
    sendEmail: async (message) => {
      sent.push(message)
    },
  })
}
function request(cache: Cache, ip: string, path: string, body?: unknown, cookie?: string) {
  return auth(cache, ip).handler(
    new Request(`${appUrl}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: appUrl,
        // 客户端伪造的 CF/XFF 头不能替代注入的可信 IP。
        'cf-connecting-ip': newId(),
        'x-forwarded-for': '203.0.113.99',
        'x-product-res-auth-client-ip': '203.0.113.100',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
function cookies(response: Response, tokenOnly = false) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => cookie && (!tokenOnly || !cookie.includes('session_data')))
    .join('; ')
}
const registration = (email: string) => ({ email, password, name: 'Node test' })

describe('Node auth with real Postgres and shared Valkey', () => {
  it('registers and signs in, reads shared cache, checks DB freshness and revokes cached sessions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const email = address('session')
    const ip = '198.51.100.1'
    const signup = await request(web, ip, '/sign-up/email', registration(email))
    expect(signup.status).toBe(200)
    const initial = (await signup.json()) as { token: string; user: { id: string } }
    expect(
      await db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, initial.user.id) }),
    ).toMatchObject({ isPersonal: true })
    const login = await request(peer, ip, '/sign-in/email', { email, password })
    expect(login.status).toBe(200)
    const victim = (await login.json()) as { token: string }
    expect(
      await db.query.session.findFirst({ where: (s, { eq }) => eq(s.token, victim.token) }),
    ).toMatchObject({ ipAddress: ip })
    expect(await web.kv('auth').get(`auth:${victim.token}`)).toContain(victim.token)
    const cached = await auth(peer, ip, refused).handler(
      new Request(`${appUrl}/api/auth/get-session`, { headers: { cookie: cookies(login, true) } }),
    )
    expect(cached.status).toBe(200)
    expect(await cached.json()).toMatchObject({ session: { token: victim.token } })

    await db.$client`delete from session where token=${initial.token}`
    expect(await peer.kv('auth').get(`auth:${initial.token}`)).not.toBeNull()
    await expect(
      requireFreshSession({
        auth: auth(peer, ip),
        db,
        headers: new Headers({ cookie: cookies(signup) }),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED', status: 401 })
    const staleWrite = await request(
      peer,
      ip,
      '/change-password',
      { currentPassword: password, newPassword: 'blocked-password-change' },
      cookies(signup),
    )
    expect(staleWrite.status).toBe(401)
    expect(await staleWrite.json()).toMatchObject({ code: 'SESSION_REQUIRED' })
    await web.kv('auth').delete(`auth:${initial.token}`)
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, initial.user.id) }),
    ).toMatchObject({ name: 'Node test' })

    const survivor = await auth(web, ip).api.signInEmail({
      body: { email, password },
      headers: new Headers({ 'x-product-res-auth-client-ip': '203.0.113.100' }),
      asResponse: true,
    })
    expect(survivor.status).toBe(200)
    const survivorSession = (await survivor.json()) as { token: string }
    expect(
      await db.query.session.findFirst({
        where: (s, { eq }) => eq(s.token, survivorSession.token),
      }),
    ).toMatchObject({ ipAddress: ip })
    const revoke = await request(
      web,
      ip,
      '/revoke-session',
      { token: victim.token },
      cookies(survivor),
    )
    expect(revoke.status).toBe(200)
    expect(await peer.kv('auth').get(`auth:${victim.token}`)).toBeNull()
    expect(
      await db.query.session.findFirst({ where: (s, { eq }) => eq(s.token, victim.token) }),
    ).toBeUndefined()
    expect(
      await (await request(peer, ip, '/get-session', undefined, cookies(login, true))).json(),
    ).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shares trusted IP and normalized email limits across independent auth instances without Turnstile', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const ip = '198.51.100.2'
    for (let i = 0; i < 3; i++)
      expect(
        (
          await request(i % 2 ? peer : web, ip, '/request-password-reset', {
            email: address('unknown'),
          })
        ).status,
      ).toBe(200)
    const blockedEmail = address('blocked-ip')
    const blocked = await request(peer, ip, '/sign-up/email', registration(blockedEmail))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, blockedEmail) }),
    ).toBeUndefined()

    const email = address('email-limit')
    const sentBefore = sent.length
    for (let i = 0; i < 4; i++) {
      const result = await request(
        i % 2 ? peer : web,
        `198.51.100.${10 + i}`,
        '/email-otp/send-verification-otp',
        { email: i % 2 ? email.toUpperCase() : email, type: 'sign-in' },
      )
      expect(result.status).toBe(i < 3 ? 200 : 429)
    }
    expect(sent.slice(sentBefore)).toHaveLength(3)
    expect(sent.slice(sentBefore).every((mail) => mail.type === 'otp')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns safe 503 before registration or mail side effects when the actual cache connection is closed', async () => {
    const failed = await createNodeCache({ url: cacheUrl, namespace: `failed-auth-${newId()}` })
    await failed.close()
    const email = address('unavailable')
    const before = sent.length
    for (const [path, body] of [
      ['/sign-up/email', registration(email)],
      ['/email-otp/send-verification-otp', { email, type: 'sign-in' }],
    ] as const) {
      const response = await request(failed, '198.51.100.20', path, body)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        code: 'CACHE_UNAVAILABLE',
        message: 'Cache is unavailable',
      })
    }
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, email) }),
    ).toBeUndefined()
    expect(
      await db.$client`select id from verification where identifier like ${`%${email}%`}`,
    ).toHaveLength(0)
    expect(sent).toHaveLength(before)
  })
})
