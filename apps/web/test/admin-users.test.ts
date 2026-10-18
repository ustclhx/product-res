import { createAuth, parseAuthEnv, requireFreshSession } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import type { KeyValueStore } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { listAuditLogs } from '../src/features/admin/audit.ts'
import { requireAdmin } from '../src/features/admin/guard.ts'
import { executeAdminAuthAction } from '../src/features/admin/impersonation.server.ts'
import { assertRealSession } from '../src/features/admin/impersonation.ts'
import { handleAuthRequest as handleRuntimeAuthRequest } from '../src/features/admin/impersonation-http.ts'
import { adminUserDetail, listAdminUsers } from '../src/features/admin/users.ts'
import { adminWorkspaceDetail, listAdminWorkspaces } from '../src/features/admin/workspaces.ts'
import { createWebAuth } from '../src/server/auth.ts'
import type { WebRuntime } from '../src/server/runtime.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { adminCache, cacheValues, createAdminTestDb, rateLimiter } from './admin-test-resources.ts'

const APP_URL = 'http://localhost:3000'
const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const domain = `${newId()}.admin-users.example`
const db = createAdminTestDb()
const cache = cacheValues
const runtimeConfig = {
  APP_URL,
  BETTER_AUTH_SECRET: SECRET,
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  GOOGLE_CLIENT_ID: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  GITHUB_CLIENT_ID: 'test',
  GITHUB_CLIENT_SECRET: 'test',
}
const auth = createAuth({ APP_URL, BETTER_AUTH_SECRET: SECRET }, db, {
  config: defineTemplateConfig({
    app: { name: 'TestApp', url: APP_URL, supportEmail: 'hxl15380@gmail.com' },
    auth: { oauth: [], turnstile: false },
  }),
  sendEmail: async () => {},
})
// 测试资源由目标夹具装配，HTTP 权限仍经过生产包装器。
function createRuntime() {
  const requestMeta = { clientIp: '203.0.113.9', requestId: newId() }
  const createAuth = (database: typeof db, cache: KeyValueStore = adminCache) =>
    createWebAuth(runtimeConfig, database, {
      cache,
      rateLimiter,
      clientIp: requestMeta.clientIp,
      sendEmail: async () => {},
    })
  const runtime: WebRuntime = {
    config: parseAuthEnv(runtimeConfig, templateConfig),
    db,
    publicDb: db,
    cache: adminCache,
    rateLimiter,
    requestMeta,
    emailQueue: { available: false },
    eventsQueue: { available: false },
    auth: createAuth(db),
    createAuth,
    handleAuthRequest: (request) => handleRuntimeAuthRequest(request, runtime),
  }
  return runtime
}
function handleAuthRequest(request: Request) {
  return createRuntime().handleAuthRequest(request)
}
function cookies(response: Response, previous = '') {
  const values = new Map<string, string>()
  for (const part of [
    ...previous.split(';').map((s) => s.trim()),
    ...response.headers.getSetCookie().map((s) => s.split(';')[0] ?? ''),
  ]) {
    if (part.includes('=')) values.set(part.slice(0, part.indexOf('=')), part)
  }
  return [...values.values()].join('; ')
}
async function actor(role = 'user') {
  const email = `${newId()}@${domain}`
  const response = await auth.handler(
    new Request(`${APP_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Searchable user' }),
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  await db.$client`update "user" set role=${role} where id=${body.user.id}`
  return {
    id: body.user.id,
    email,
    headers: new Headers({
      cookie: cookies(response),
      origin: APP_URL,
      'content-type': 'application/json',
    }),
  }
}
function action(headers: Headers, path: string, body?: unknown) {
  return executeAdminAuthAction({
    db,
    runtime: createRuntime(),
    headers,
    path,
    ...(body ? { body } : {}),
  })
}

afterAll(async () => {
  const sql = createAdminTestDb('migrator').$client
  const users = await sql<{ id: string }[]>`select id from "user" where email like ${`%@${domain}`}`
  const ids = users.map((u) => u.id)
  if (!ids.length) return
  await sql`delete from audit_log where actor_user_id in ${sql(ids)} or workspace_id in ${sql(ids)}`
  await sql`delete from member where user_id in ${sql(ids)}`
  await sql`delete from session where user_id in ${sql(ids)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from organization where id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('用户与空间后台', () => {
  it('非管理员直接访问管理 API，即使输入畸形也只得到 404', async () => {
    const target = await actor()
    for (const headers of [
      target.headers,
      new Headers({ origin: APP_URL, 'content-type': 'application/json' }),
    ]) {
      for (const path of [
        '/admin/ban-user',
        '/admin/impersonate-user',
        '/admin/stop-impersonating',
      ]) {
        const response = await handleAuthRequest(
          new Request(`${APP_URL}/api/auth${path}`, { method: 'POST', headers, body: '{' }),
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' })
      }
    }
  })
  it('管理员也不能调用白名单外的原生写接口', async () => {
    const admin = await actor('admin')
    const target = await actor()
    const response = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/admin/set-role`, {
        method: 'POST',
        headers: admin.headers,
        body: JSON.stringify({ userId: target.id, role: 'admin' }),
      }),
    )
    expect(response.status).toBe(404)
    expect((await requireFreshSession({ db, auth, headers: target.headers })).user.role).toBe(
      'user',
    )
  })
  it('按邮箱、姓名和 ID 搜索并查看所属空间及登录方式', async () => {
    const target = await actor()
    for (const q of [target.email, 'Searchable user', target.id])
      expect(
        (await listAdminUsers(db, { offset: 0, q })).rows.some((u) => u.id === target.id),
      ).toBe(true)
    expect(await adminUserDetail(db, target.id)).toMatchObject({
      user: { id: target.id },
      methods: ['credential'],
      workspaces: [expect.objectContaining({ id: target.id, role: 'owner' })],
    })
    expect((await listAdminWorkspaces(db, { q: target.id })).rows.map((w) => w.id)).toContain(
      target.id,
    )
    expect(await adminWorkspaceDetail(db, target.id, 7)).toMatchObject({
      members: [expect.objectContaining({ userId: target.id })],
      balance: { available: 0, held: 0, debt: 0 },
    })
  })
  it('封禁立即吊销旧会话，解封要求原因并写审计，拒绝封禁自己', async () => {
    const admin = await actor('admin')
    const target = await actor()
    await expect(
      action(admin.headers, '/admin/ban-user', { userId: admin.id, banReason: 'Self' }),
    ).rejects.toMatchObject({ code: 'SELF_BAN_FORBIDDEN' })
    await expect(
      action(admin.headers, '/admin/ban-user', { userId: target.id }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await action(admin.headers, '/admin/ban-user', { userId: target.id, banReason: 'Abuse report' })
    await expect(requireFreshSession({ db, auth, headers: target.headers })).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
    const [row] = await db.$client`select banned,ban_reason from "user" where id=${target.id}`
    expect(row).toMatchObject({ banned: true, ban_reason: 'Abuse report' })
    await action(admin.headers, '/admin/unban-user', {
      userId: target.id,
      banReason: 'Reviewed appeal',
    })
    const audit =
      await db.$client`select actor_user_id,action,meta from audit_log where target_id=${target.id} order by created_at`
    expect(audit).toMatchObject([
      { actor_user_id: admin.id, action: 'user.banned', meta: { reason: 'Abuse report' } },
      { actor_user_id: admin.id, action: 'user.unbanned', meta: { reason: 'Reviewed appeal' } },
    ])
  })
  it('审计写入失败时，原生封禁 / 模拟会话与缓存副作用一起回滚', async () => {
    const admin = await actor('admin')
    const target = await actor()
    const migrator = createAdminTestDb('migrator').$client
    const trigger = `test_reject_admin_${newId().replaceAll('-', '')}`
    const cachedBefore = new Map(cache)
    try {
      await migrator.unsafe(
        `create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.target_id = '${target.id}' then raise exception 'test audit rejected'; end if; return NEW; end $$`,
      )
      await migrator.unsafe(
        `create trigger ${trigger} before insert on audit_log for each row execute function ${trigger}()`,
      )
      for (const path of ['/admin/ban-user', '/admin/impersonate-user'])
        await expect(
          action(admin.headers, path, { userId: target.id, banReason: 'Rollback test' }),
        ).rejects.toThrow()
      expect((await requireFreshSession({ db, auth, headers: target.headers })).user.banned).toBe(
        false,
      )
      expect(
        await db.$client`select id from session where user_id=${target.id} and impersonated_by is not null`,
      ).toHaveLength(0)
      expect(cache).toEqual(cachedBefore)
      expect(await db.$client`select id from audit_log where target_id=${target.id}`).toHaveLength(
        0,
      )
    } finally {
      await migrator.unsafe(`drop trigger if exists ${trigger} on audit_log`)
      await migrator.unsafe(`drop function if exists ${trigger}()`)
    }
  })
  it('模拟开始与结束记录双重身份，不能模拟管理员，敏感接口与后台被拒绝', async () => {
    const admin = await actor('admin')
    const target = await actor()
    await expect(
      action(admin.headers, '/admin/impersonate-user', { userId: admin.id }),
    ).rejects.toMatchObject({ code: 'IMPERSONATE_ADMIN_FORBIDDEN' })
    const started = await action(admin.headers, '/admin/impersonate-user', { userId: target.id })
    const headers = new Headers(admin.headers)
    headers.set('cookie', cookies(started, admin.headers.get('cookie') ?? ''))
    const fresh = await requireFreshSession({ db, auth, headers })
    expect(fresh.session.impersonatedBy).toBe(admin.id)
    expect(() => assertRealSession(fresh.session)).toThrow('Sensitive actions')
    await expect(requireAdmin({ db, auth, headers })).rejects.toMatchObject({ status: 404 })
    for (const path of ['/change-password', '/two-factor/enable', '/deletion/account']) {
      const result = await handleAuthRequest(
        new Request(`${APP_URL}/api/auth${path}`, { method: 'POST', headers, body: '{}' }),
      )
      expect(result.status).toBe(403)
      expect(await result.json()).toMatchObject({ code: 'IMPERSONATION_FORBIDDEN' })
    }
    headers.set('cf-connecting-ip', '203.0.113.200')
    headers.set('x-forwarded-for', '203.0.113.201')
    const invalid = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/update-user`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ timezone: 'Invalid/Timezone' }),
      }),
    )
    expect(invalid.status).toBe(400)

    const updated = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/update-user`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Audited profile' }),
      }),
    )
    expect(updated.status).toBe(200)
    const profileAudit = await listAuditLogs(db, {
      offset: 0,
      actor: admin.id,
      action: 'user.profile_updated',
    })
    expect(profileAudit.rows).toMatchObject([
      {
        log: {
          actorUserId: target.id,
          targetId: target.id,
          ip: '203.0.113.9',
          meta: {
            impersonatedBy: admin.id,
            before: { name: 'Searchable user' },
            after: { name: 'Audited profile' },
          },
        },
      },
    ])
    const stopHeaders = new Headers(headers)
    stopHeaders.delete('content-type')
    const ended = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/admin/stop-impersonating`, {
        method: 'POST',
        headers: stopHeaders,
      }),
    )
    expect(ended.status).toBe(200)
    headers.set('cookie', cookies(ended, headers.get('cookie') ?? ''))
    expect((await requireAdmin({ db, auth, headers })).user.id).toBe(admin.id)
    const audit =
      await db.$client`select actor_user_id,action,meta from audit_log where target_id=${target.id} and action like 'user.impersonation.%' order by created_at`
    expect(audit).toMatchObject([
      {
        actor_user_id: admin.id,
        action: 'user.impersonation.started',
        meta: { userId: target.id, actualAdminId: admin.id },
      },
      {
        actor_user_id: admin.id,
        action: 'user.impersonation.ended',
        meta: { userId: target.id, actualAdminId: admin.id },
      },
    ])
  })
  it('恢复软删空间时重新加入原 owner，并以管理员身份写审计', async () => {
    const admin = await actor('admin')
    const owner = await actor()
    await db.$client`update organization set deleted_at=now() where id=${owner.id}`
    await db.$client`delete from member where organization_id=${owner.id}`
    await db.$client`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,meta) values (${newId()},${owner.id},${owner.id},'workspace.deleted','organization',${owner.id},${JSON.stringify({ originalOwnerUserIds: [owner.id] })}::jsonb)`
    expect((await listAdminWorkspaces(db, { status: 'deleted', q: owner.id })).rows).toHaveLength(1)
    const restored = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/admin/restore-workspace`, {
        method: 'POST',
        headers: admin.headers,
        body: JSON.stringify({ workspaceId: owner.id }),
      }),
    )
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ restored: true, ownerUserIds: [owner.id] })
    const [member] =
      await db.$client`select role from member where organization_id=${owner.id} and user_id=${owner.id}`
    expect(member).toMatchObject({ role: 'owner' })
    const [audit] =
      await db.$client`select actor_user_id from audit_log where workspace_id=${owner.id} and action='workspace.restored'`
    expect(audit?.actor_user_id).toBe(admin.id)
  })
})
