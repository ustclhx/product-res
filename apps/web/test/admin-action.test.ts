import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { auditLog, type createDb, setting } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ADMIN_ACTION_UNAUDITED,
  AdminAccessRevokedError,
  runAdminAction,
  runDelegatedAdminAction,
} from '../src/features/admin/action.ts'
import { requireAdmin } from '../src/features/admin/guard.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

// add-admin-console tasks.md 1.1：adminAction 包装。
// 「旧会话」= 请求开始时守卫已放行（模拟 adminMiddleware），随后角色被撤销 / 用户被封禁。

const APP_URL = 'http://localhost:3000'
const PASSWORD = 'correct-horse-battery-staple'
const EMAIL_DOMAIN = `${newId()}.web-admin-action-test.example`
const SETTING_PREFIX = `test.admin-action.${newId()}`

function setup() {
  const db = createAdminTestDb()
  const auth = createAuth(
    { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
    db,
    {
      config: defineTemplateConfig({
        app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
        auth: { oauth: [], turnstile: false },
      }),
      sendEmail: async () => {},
    },
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

/** 已登录的管理员，且守卫已按数据库放行（等同 adminMiddleware 通过后的上下文） */
async function freshAdmin(s: ReturnType<typeof setup>) {
  const email = `admin-${newId()}@${EMAIL_DOMAIN}`
  const signUp = await s.post('/sign-up/email', { email, password: PASSWORD, name: 'admin' })
  expect(signUp.status).toBe(200)
  const { user } = (await signUp.json()) as { user: { id: string } }
  await s.db.$client`update "user" set role = 'admin' where id = ${user.id}`
  const res = await s.post('/sign-in/email', { email, password: PASSWORD })
  expect(res.status).toBe(200)
  const headers = new Headers({
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .join('; '),
  })
  const fresh = await requireAdmin({ auth: s.auth, db: s.db, headers })
  return { id: fresh.user.id, headers }
}

const settingKey = () => `${SETTING_PREFIX}.${newId()}`
const audits = (db: ReturnType<typeof createDb>, targetId: string) =>
  db.select().from(auditLog).where(eq(auditLog.targetId, targetId))
const settings = (db: ReturnType<typeof createDb>, key: string) =>
  db.select().from(setting).where(eq(setting.key, key))

/** 一次典型的后台写操作：写业务表并记审计 */
function writeSetting(key: string, after?: () => void) {
  return async ({ tx, audit }: Parameters<Parameters<typeof runAdminAction>[2]>[0]) => {
    await tx.insert(setting).values({ key, value: { on: true } })
    await audit({ action: 'test.setting_written', targetType: 'setting', targetId: key })
    after?.()
    return key
  }
}

afterAll(async () => {
  const sql = createAdminTestDb().$client
  await sql`delete from setting where key like ${`${SETTING_PREFIX}.%`}`
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  // audit_log 对 app 只追加，审计行由 migrator 清理
  await createAdminTestDb('migrator')
    .$client`delete from audit_log where actor_user_id in ${sql(ids)}`
  await sql`delete from session where user_id in ${sql(ids)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from member where user_id in ${sql(ids)}`
  await sql`delete from organization where id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('adminAction', () => {
  it('业务写入与审计同事务提交，审计带操作人与来源 IP', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    const key = settingKey()
    const result = await runAdminAction(
      { db: s.db, admin, ip: '203.0.113.7' },
      'test.write',
      writeSetting(key),
    )
    expect(result).toBe(key)
    expect(await settings(s.db, key)).toHaveLength(1)
    expect(await audits(s.db, key)).toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        action: 'test.setting_written',
        targetType: 'setting',
        ip: '203.0.113.7',
        workspaceId: null,
      }),
    ])
  })

  it('被降级的管理员旧会话：守卫 404，已进入的写操作被拒绝且不留任何写入', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    await s.db.$client`update "user" set role = 'user' where id = ${admin.id}`

    await expect(
      requireAdmin({ auth: s.auth, db: s.db, headers: admin.headers }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    const key = settingKey()
    await expect(
      runAdminAction({ db: s.db, admin }, 'test.write', writeSetting(key)),
    ).rejects.toBeInstanceOf(AdminAccessRevokedError)
    await expect(
      runDelegatedAdminAction({ db: s.db, admin }, async () => 'called'),
    ).rejects.toBeInstanceOf(AdminAccessRevokedError)
    expect(await settings(s.db, key)).toEqual([])
    expect(await audits(s.db, key)).toEqual([])
  })

  it('被封禁的管理员同样被拒绝', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    await s.db.$client`update "user" set banned = true where id = ${admin.id}`
    const key = settingKey()
    await expect(
      runAdminAction({ db: s.db, admin }, 'test.write', writeSetting(key)),
    ).rejects.toBeInstanceOf(AdminAccessRevokedError)
    expect(await audits(s.db, key)).toEqual([])
  })

  it('操作失败时业务写入与审计一起回滚', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    const key = settingKey()
    await expect(
      runAdminAction(
        { db: s.db, admin },
        'test.write',
        writeSetting(key, () => {
          throw new Error('provider exploded')
        }),
      ),
    ).rejects.toThrow('provider exploded')
    expect(await settings(s.db, key)).toEqual([])
    expect(await audits(s.db, key)).toEqual([])
  })

  it('没有写审计的操作整体回滚', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    const key = settingKey()
    await expect(
      runAdminAction({ db: s.db, admin }, 'test.unaudited', async ({ tx }) => {
        await tx.insert(setting).values({ key, value: { on: true } })
      }),
    ).rejects.toMatchObject({ code: ADMIN_ACTION_UNAUDITED })
    expect(await settings(s.db, key)).toEqual([])
  })

  it('委托模式只做实时角色校验，由业务函数自行写入', async () => {
    const s = setup()
    const admin = await freshAdmin(s)
    expect(await runDelegatedAdminAction({ db: s.db, admin }, async () => 'called')).toBe('called')
    expect(await s.db.select().from(auditLog).where(eq(auditLog.actorUserId, admin.id))).toEqual([])
  })
})
