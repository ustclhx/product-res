import { env } from 'cloudflare:workers'
import { AppError } from '@product-res/shared'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireFreshSession, SESSION_REQUIRED, USER_BANNED } from '../src/index.ts'
import {
  APP_URL,
  cookieHeader,
  mockTurnstile,
  PASSWORD,
  setup,
  signUpBody,
  testUsers,
} from './helpers.ts'

// requireFreshSession 守卫（tasks.md 2.3，specs/user-auth「敏感操作实时校验会话」）：
// 会话与封禁状态直接查库，不受 Cookie 缓存与 KV 影响。

const users = testUsers('fresh')

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

async function signedInUser(
  s: ReturnType<typeof setup>,
  name: string,
  beforeSignIn?: (userId: string) => Promise<unknown>,
) {
  const address = users.email(name)
  const signUp = await s.post('/sign-up/email', signUpBody(address))
  expect(signUp.status).toBe(200)
  await beforeSignIn?.(((await signUp.json()) as { user: { id: string } }).user.id)
  const res = await s.post('/sign-in/email', { email: address, password: PASSWORD })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { address, cookie: cookieHeader(res), token: body.token, userId: body.user.id }
}

const headersOf = (cookie: string) => new Headers({ cookie, origin: APP_URL })

async function expectRejected(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({ code, status })
}

describe('requireFreshSession', () => {
  it('有效会话返回数据库中的会话与用户', async () => {
    const s = setup()
    const u = await signedInUser(s, 'ok')
    const fresh = await requireFreshSession({
      auth: s.auth,
      db: s.db,
      headers: headersOf(u.cookie),
    })
    expect(fresh.session.token).toBe(u.token)
    expect(fresh.user).toMatchObject({ id: u.userId, email: u.address })
  })

  it('没有 Cookie 或签名被篡改时返回 401', async () => {
    const s = setup()
    const u = await signedInUser(s, 'tampered')
    await expectRejected(
      requireFreshSession({ auth: s.auth, db: s.db, headers: new Headers() }),
      SESSION_REQUIRED,
      401,
    )
    // 换一个 token、保留原签名
    const forged = u.cookie.replace(
      u.token,
      `${u.token.slice(0, -1)}${u.token.endsWith('x') ? 'y' : 'x'}`,
    )
    await expectRejected(
      requireFreshSession({ auth: s.auth, db: s.db, headers: headersOf(forged) }),
      SESSION_REQUIRED,
      401,
    )
  })

  it('数据库中会话已删除时立即拒绝，即使 Cookie 缓存与 KV 仍有该会话', async () => {
    const s = setup()
    const u = await signedInUser(s, 'deleted')
    const sql = s.db.$client
    await sql`delete from session where token = ${u.token}`
    // 缓存层仍认为会话有效
    expect(await env.CACHE.get(`auth:${u.token}`)).not.toBeNull()
    const cached = await s.get('/get-session', { cookie: u.cookie })
    expect(((await cached.json()) as { session?: unknown } | null)?.session).toBeDefined()

    await expectRejected(
      requireFreshSession({ auth: s.auth, db: s.db, headers: headersOf(u.cookie) }),
      SESSION_REQUIRED,
      401,
    )
  })

  it('用户在数据库中被封禁后 10 秒内访问受保护接口被拒绝（缓存层尚未感知）', async () => {
    const s = setup()
    const u = await signedInUser(s, 'banned-db')
    const started = Date.now()
    // 模拟封禁已写库、但 KV 删除尚未传播到当前节点：只改数据库
    await s.db.$client`update "user" set banned = true, ban_reason = 'test' where id = ${u.userId}`

    // 普通页面走缓存，仍能取到会话（spec 允许的吊销延迟）
    const cached = await s.get('/get-session', { cookie: u.cookie })
    expect(((await cached.json()) as { session?: unknown } | null)?.session).toBeDefined()

    // 守卫直接查库：拒绝
    await expectRejected(
      requireFreshSession({ auth: s.auth, db: s.db, headers: headersOf(u.cookie) }),
      USER_BANNED,
      403,
    )
    // Better Auth 自带的敏感接口同样被拒绝
    const change = await s.post(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'another-long-password-1' },
      { cookie: u.cookie },
    )
    expect(change.status).toBe(403)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('管理员经 admin 插件封禁后，被封禁用户 10 秒内访问受保护接口被拒绝', async () => {
    const s = setup()
    // 角色在登录前写库，使管理员的会话缓存中带有 admin 角色
    const admin = await signedInUser(
      s,
      'admin',
      (id) => s.db.$client`update "user" set role = 'admin' where id = ${id}`,
    )
    const victim = await signedInUser(s, 'banned-admin')

    const started = Date.now()
    const ban = await s.post(
      '/admin/ban-user',
      { userId: victim.userId, banReason: 'test' },
      { cookie: admin.cookie },
    )
    expect(ban.status).toBe(200)
    await expectRejected(
      requireFreshSession({ auth: s.auth, db: s.db, headers: headersOf(victim.cookie) }),
      SESSION_REQUIRED,
      401,
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    // 管理员自己不受影响
    const fresh = await requireFreshSession({
      auth: s.auth,
      db: s.db,
      headers: headersOf(admin.cookie),
    })
    expect(fresh.user.role).toBe('admin')
  })

  it('封禁过期后恢复访问', async () => {
    const s = setup()
    const u = await signedInUser(s, 'ban-expired')
    await s.db
      .$client`update "user" set banned = true, ban_expires = now() - interval '1 minute' where id = ${u.userId}`
    const fresh = await requireFreshSession({
      auth: s.auth,
      db: s.db,
      headers: headersOf(u.cookie),
    })
    expect(fresh.user.id).toBe(u.userId)
  })
})
