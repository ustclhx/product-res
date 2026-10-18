import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireFreshSession, SESSION_COOKIE_CACHE_MAX_AGE } from '../src/index.ts'
import {
  APP_URL,
  cookieHeader,
  mockTurnstile,
  PASSWORD,
  setup,
  signUpBody,
  testUsers,
} from './helpers.ts'

// 用户设置（tasks.md 5.2）：资料 / 语言 / 时区经 /update-user 写入 user 表并在服务端校验；
// 修改密码后其他会话按 specs/user-auth「敏感操作实时校验会话」的时限失效。

const users = testUsers('settings')

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

async function signUp(s: ReturnType<typeof setup>, name: string) {
  const address = users.email(name)
  const res = await s.post('/sign-up/email', signUpBody(address))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { user: { id: string } }
  return { address, userId: body.user.id }
}

async function signIn(s: ReturnType<typeof setup>, address: string, password = PASSWORD) {
  const res = await s.post('/sign-in/email', { email: address, password })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string }
  return { cookie: cookieHeader(res), token: body.token }
}

async function sessionOf(s: ReturnType<typeof setup>, cookie: string) {
  const res = await s.get('/get-session', { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { session: { token: string }; user: Record<string, unknown> } | null
}

const userRow = (s: ReturnType<typeof setup>, id: string) =>
  s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, id) })

describe('资料、语言与时区', () => {
  it('写入 user 表的扩展字段，并刷新 Cookie 缓存中的用户', async () => {
    const s = setup()
    const u = await signUp(s, 'profile')
    const { cookie } = await signIn(s, u.address)

    const res = await s.post(
      '/update-user',
      {
        name: '  New Name  ',
        image: 'https://product.ezarouter.cc/a.png',
        locale: 'zh',
        timezone: 'Asia/Shanghai',
      },
      { cookie },
    )
    expect(res.status).toBe(200)
    expect(await userRow(s, u.userId)).toMatchObject({
      name: 'New Name',
      image: 'https://product.ezarouter.cc/a.png',
      locale: 'zh',
      timezone: 'Asia/Shanghai',
    })
    // 响应下发了新的 Cookie 缓存，普通页面立即看到新资料
    const session = await sessionOf(s, cookieHeader(res))
    expect(session?.user).toMatchObject({ name: 'New Name', locale: 'zh' })

    // null 清除语言与时区（回到默认值）
    const clear = await s.post('/update-user', { locale: null, timezone: null }, { cookie })
    expect(clear.status).toBe(200)
    expect(await userRow(s, u.userId)).toMatchObject({ locale: null, timezone: null })
  })

  it.each([
    ['不在模板配置中的语言', { locale: 'fr' }],
    ['未知时区', { timezone: 'Mars/Olympus' }],
    ['空名字', { name: '   ' }],
    ['过长的名字', { name: 'x'.repeat(101) }],
    ['非 http(s) 头像', { image: 'javascript:alert(1)' }],
  ])('拒绝%s', async (_, body) => {
    const s = setup()
    const u = await signUp(s, 'invalid')
    const { cookie } = await signIn(s, u.address)
    const before = await userRow(s, u.userId)

    const res = await s.post('/update-user', body, { cookie })
    expect(res.status).toBe(400)
    expect(await userRow(s, u.userId)).toEqual(before)
  })

  it('未登录不能修改', async () => {
    const s = setup()
    const res = await s.post('/update-user', { name: 'x' })
    expect(res.status).toBe(401)
  })
})

describe('修改密码后其他会话失效', () => {
  it('敏感操作立即被拒，普通页面在 Cookie 缓存时长内失效；当前会话不受影响', async () => {
    const s = setup()
    const u = await signUp(s, 'change-password')
    const current = await signIn(s, u.address)
    const other = await signIn(s, u.address)
    const NEW_PASSWORD = 'another-long-password-1'

    // 客户端没有要求吊销其他会话，服务端仍然吊销
    const change = await s.post(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie: current.cookie },
    )
    expect(change.status).toBe(200)
    const changed = (await change.json()) as { token: string | null }
    expect(changed.token).not.toBeNull()
    const renewed = cookieHeader(change)

    // 数据库与 KV 中都已删除旧会话
    expect(
      await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, other.token) }),
    ).toBeUndefined()
    expect(await env.CACHE.get(`auth:${other.token}`)).toBeNull()

    // 敏感操作立即被拒：requireFreshSession 与 Better Auth 自带的敏感接口
    await expect(
      requireFreshSession({
        auth: s.auth,
        db: s.db,
        headers: new Headers({ cookie: other.cookie, origin: APP_URL }),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED', status: 401 })
    const sensitive = await s.post(
      '/change-password',
      { currentPassword: NEW_PASSWORD, newPassword: 'third-long-password-1' },
      { cookie: other.cookie },
    )
    expect(sensitive.status).toBe(401)

    // 普通页面：Cookie 缓存有效期内旧会话仍被接受（spec 允许的吊销延迟）
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    vi.setSystemTime(Date.now() + (SESSION_COOKIE_CACHE_MAX_AGE - 10) * 1000)
    expect((await sessionOf(s, other.cookie))?.session.token).toBe(other.token)
    // 缓存过期后失效（KV 副本已删除，本地无传播延迟；线上最多再加约 60 秒）
    vi.setSystemTime(Date.now() + 20 * 1000)
    expect(await sessionOf(s, other.cookie)).toBeNull()

    // 发起修改的一方换发了新会话，继续有效；新密码可登录、旧密码不行
    expect((await sessionOf(s, renewed))?.session.token).toBe(changed.token)
    vi.useRealTimers()
    expect(
      (
        await requireFreshSession({
          auth: s.auth,
          db: s.db,
          headers: new Headers({ cookie: renewed }),
        })
      ).user.id,
    ).toBe(u.userId)
    await signIn(s, u.address, NEW_PASSWORD)
    const old = await s.post('/sign-in/email', { email: u.address, password: PASSWORD })
    expect(old.status).toBe(401)
  })

  it('经找回密码重置后吊销全部会话', async () => {
    const s = setup()
    const u = await signUp(s, 'reset')
    const before = await signIn(s, u.address)

    const request = await s.post('/request-password-reset', {
      email: u.address,
      redirectTo: '/reset-password',
    })
    expect(request.status).toBe(200)
    const mail = s.sent.find((m) => m.type === 'reset-password')
    const token = new URL(mail?.type === 'reset-password' ? mail.url : '').pathname.split('/').pop()
    const reset = await s.post('/reset-password', {
      token,
      newPassword: 'another-long-password-2',
    })
    expect(reset.status).toBe(200)

    expect(
      await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, before.token) }),
    ).toBeUndefined()
    await expect(
      requireFreshSession({
        auth: s.auth,
        db: s.db,
        headers: new Headers({ cookie: before.cookie }),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  })
})
