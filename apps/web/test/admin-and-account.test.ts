import { createAuth, requireFreshSession } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { AppError, newId } from '@product-res/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isGatedAdminPath } from '../src/features/admin/gate.ts'
import { isPlatformAdmin, requireAdmin } from '../src/features/admin/guard.ts'
import { loadAccount } from '../src/features/settings/account.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

// tasks.md 5.1：/admin 的角色守卫，非 admin（含未登录、被封禁）一律 404；
// tasks.md 5.2：设置页的数据（loadAccount）。页面与 server function 的端到端验证见 PR 描述。

const APP_URL = 'http://localhost:3000'
const PASSWORD = 'correct-horse-battery-staple'
const EMAIL_DOMAIN = `${newId()}.web-admin-test.example`
let startedAt = new Date()

const config = (twoFactor = false) =>
  defineTemplateConfig({
    app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
    auth: { oauth: [], turnstile: false, twoFactor },
  })

function setup() {
  const db = createAdminTestDb()
  const auth = createAuth(
    { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
    db,
    { config: config(), sendEmail: async () => {} },
  )
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL },
        body: JSON.stringify(body),
      }),
    )
  return { db, auth, post }
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .join('; ')

async function signedIn(s: ReturnType<typeof setup>, name: string, role?: string) {
  const email = `${name}-${newId()}@${EMAIL_DOMAIN}`
  const signUp = await s.post('/sign-up/email', { email, password: PASSWORD, name })
  expect(signUp.status).toBe(200)
  const { user } = (await signUp.json()) as { user: { id: string } }
  if (role) await s.db.$client`update "user" set role = ${role} where id = ${user.id}`
  const res = await s.post('/sign-in/email', { email, password: PASSWORD })
  expect(res.status).toBe(200)
  return { id: user.id, email, headers: new Headers({ cookie: cookieOf(res) }) }
}

async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 })
}

beforeAll(() => {
  startedAt = new Date()
})

afterAll(async () => {
  const sql = createAdminTestDb().$client
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  await sql`delete from verification where created_at >= ${startedAt.toISOString()}`
  if (ids.length === 0) return
  await sql`delete from session where user_id in ${sql(ids)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  // 注册会创建个人空间（id 与用户 id 相同，PR #16），外键为 restrict，需先删成员与空间
  await sql`delete from member where user_id in ${sql(ids)}`
  await sql`delete from organization where id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('/admin 角色守卫', () => {
  it('admin 通过，返回数据库中的用户', async () => {
    const s = setup()
    const admin = await signedIn(s, 'admin', 'admin')
    const fresh = await requireAdmin({ auth: s.auth, db: s.db, headers: admin.headers })
    expect(fresh.user).toMatchObject({ id: admin.id, role: 'admin' })
  })

  it('普通用户、未登录、伪造 Cookie 一律 404', async () => {
    const s = setup()
    const user = await signedIn(s, 'user')
    await expectNotFound(requireAdmin({ auth: s.auth, db: s.db, headers: user.headers }))
    await expectNotFound(requireAdmin({ auth: s.auth, db: s.db, headers: new Headers() }))
    await expectNotFound(
      requireAdmin({
        auth: s.auth,
        db: s.db,
        headers: new Headers({ cookie: 'better-auth.session_token=forged.x' }),
      }),
    )
  })

  it('角色在登录后被撤销或用户被封禁时立即 404（按数据库，不看会话缓存）', async () => {
    const s = setup()
    const demoted = await signedIn(s, 'demoted', 'admin')
    await s.db.$client`update "user" set role = 'user' where id = ${demoted.id}`
    await expectNotFound(requireAdmin({ auth: s.auth, db: s.db, headers: demoted.headers }))

    const banned = await signedIn(s, 'banned-admin', 'admin')
    await s.db.$client`update "user" set banned = true where id = ${banned.id}`
    await expectNotFound(requireAdmin({ auth: s.auth, db: s.db, headers: banned.headers }))
  })

  it('与 admin 插件一致地识别逗号分隔的多角色', () => {
    expect(isPlatformAdmin('admin')).toBe(true)
    expect(isPlatformAdmin('user,admin')).toBe(true)
    expect(isPlatformAdmin('user')).toBe(false)
    expect(isPlatformAdmin('superadmin')).toBe(false)
    expect(isPlatformAdmin(null)).toBe(false)
  })
})

describe('/admin 请求入口的守卫范围', () => {
  it('只拦截 /admin 及其子路径；末尾带 / 的路径交给路由器先重定向', () => {
    expect(isGatedAdminPath('/admin')).toBe(true)
    expect(isGatedAdminPath('/admin/users')).toBe(true)
    expect(isGatedAdminPath('/admin/')).toBe(false)
    expect(isGatedAdminPath('/administrator')).toBe(false)
    expect(isGatedAdminPath('/app/admin')).toBe(false)
    expect(isGatedAdminPath('/')).toBe(false)
  })
})

describe('设置页数据', () => {
  it('包含资料、语言时区、是否有密码，两步验证按模板配置', async () => {
    const s = setup()
    const u = await signedIn(s, 'account')
    await s.db.$client`update "user" set locale = 'zh', timezone = 'Asia/Tokyo' where id = ${u.id}`
    const { user } = await requireFreshSession({ auth: s.auth, db: s.db, headers: u.headers })

    const view = await loadAccount(s.db, user, config(false))
    expect(view).toEqual({
      user: {
        id: u.id,
        name: 'account',
        email: u.email,
        emailVerified: false,
        image: null,
        locale: 'zh',
        timezone: 'Asia/Tokyo',
        twoFactorEnabled: false,
      },
      hasPassword: true,
      twoFactorAvailable: false,
      locales: ['en', 'zh'],
    })
    expect((await loadAccount(s.db, user, config(true))).twoFactorAvailable).toBe(true)

    // 只有 OAuth 账号（没有密码凭据）
    await s.db.$client`update account set password = null where user_id = ${u.id}`
    expect((await loadAccount(s.db, user, config(false))).hasPassword).toBe(false)
  })
})
