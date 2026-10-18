import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import { newId } from '@product-res/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteTeamWorkspace } from '../src/deletion.ts'
import { cleanupExpiredWorkspaces, restoreWorkspace } from '../src/workspace-lifecycle.ts'
import { cookieHeader, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('lifecycle')
const app = () =>
  setup({
    rateLimiter: { limit: async () => ({ success: true }) },
    config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
  })
beforeAll(() => users.start())
afterAll(async () => {
  const sql = app().db.$client
  // audit_log 对 app 只追加，审计行由 migrator 清理
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR).$client
  for (const id of users.createdOrgs) {
    await sql`delete from notification where workspace_id=${id}`
    await migrator`delete from audit_log where workspace_id=${id}`
  }
  await users.cleanup()
})
async function actor(a: ReturnType<typeof app>, admin = false) {
  const response = await a.post('/sign-up/email', signUpBody(users.email('actor')))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  if (admin) await a.db.$client`update "user" set role='admin' where id=${user.id}`
  return {
    id: user.id,
    options: { auth: a.auth, db: a.db, headers: new Headers({ cookie: cookieHeader(response) }) },
  }
}
async function deletedTeam(a: ReturnType<typeof app>, formerMemberId?: string) {
  const owner = await actor(a)
  const id = newId()
  users.createdOrgs.push(id)
  await a.db.$client`insert into organization (id,name,slug) values (${id},'Lifecycle',${id})`
  await a.db
    .$client`insert into member (id,organization_id,user_id,role) values (${newId()},${id},${owner.id},'owner')`
  if (formerMemberId)
    await a.db
      .$client`insert into member (id,organization_id,user_id,role) values (${newId()},${id},${formerMemberId},'member')`
  await deleteTeamWorkspace({ ...owner.options, workspaceId: id })
  return { id, owner }
}
describe('workspace lifecycle in workerd', () => {
  it('restores valid owners and content without renewing former memberships or invitations', async () => {
    const a = app(),
      admin = await actor(a, true),
      other = await actor(a)
    const { id, owner } = await deletedTeam(a, other.id)
    const keyId = newId()
    await a.db
      .$client`insert into apikey (id,reference_id,key,enabled,metadata) values (${keyId},${owner.id},${keyId},false,${JSON.stringify({ workspaceId: id })})`
    await a.db
      .$client`insert into invitation (id,organization_id,email,inviter_id,status,expires_at)
      values (${newId()},${id},'former@example.test',${owner.id},'canceled',now()+interval '1 day')`
    await a.db
      .$client`insert into notification (id,user_id,workspace_id,type,title) values (${newId()},${other.id},${id},'test','retained')`
    const restored = await a.post(
      '/admin/restore-workspace',
      { workspaceId: id },
      { cookie: admin.options.headers.get('cookie') ?? '' },
    )
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({ restored: true, ownerUserIds: [owner.id] })
    expect(
      await a.db.query.auditLog.findMany({
        where: (log, { and, eq }) =>
          and(eq(log.workspaceId, id), eq(log.action, 'workspace.restored')),
      }),
    ).toMatchObject([{ actorUserId: admin.id, ip: a.ip, meta: { ownerUserIds: [owner.id] } }])
    expect(
      await a.db.query.member.findMany({ where: (m, { eq }) => eq(m.organizationId, id) }),
    ).toMatchObject([{ userId: owner.id, role: 'owner' }])
    expect(
      await a.db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.organizationId, id) }),
    ).toMatchObject({ status: 'canceled' })
    expect(
      (await a.db.query.apikey.findFirst({ where: (k, { eq }) => eq(k.id, keyId) }))?.enabled,
    ).toBe(false)
    await a.db.$client`delete from apikey where id=${keyId}`
    expect(
      await a.db.query.notification.findFirst({ where: (n, { eq }) => eq(n.workspaceId, id) }),
    ).toBeTruthy()
  })
  it('rejects ordinary, revoked and banned administrators using current DB state', async () => {
    const a = app(),
      admin = await actor(a, true),
      ordinary = await actor(a)
    const { id } = await deletedTeam(a)
    await expect(restoreWorkspace({ ...ordinary.options, workspaceId: id })).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    })
    await a.db.$client`update "user" set role='user' where id=${admin.id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    })
    await a.db.$client`update "user" set role='admin',banned=true where id=${admin.id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'USER_BANNED',
    })
    await a.db.$client`update "user" set banned=false where id=${admin.id}`
    await a.db.$client`delete from session where user_id=${admin.id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
  })
  it('rejects unavailable owners and ownership cap overflow', async () => {
    const a = app(),
      admin = await actor(a, true)
    const { id, owner } = await deletedTeam(a)
    await a.db.$client`update "user" set banned=true,ban_expires=null where id=${owner.id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'WORKSPACE_OWNER_UNAVAILABLE',
    })
    await a.db
      .$client`update "user" set banned=false,email=${`deleted+${owner.id}@invalid`} where id=${owner.id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'WORKSPACE_OWNER_UNAVAILABLE',
    })
    await a.db
      .$client`update "user" set email=${users.email('restored-address')} where id=${owner.id}`
    await expect(
      restoreWorkspace({ ...admin.options, workspaceId: id, maxWorkspacesPerUser: 0 }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' })
  })
  it('cleans expired content once, preserves anchors and permanently prevents restore', async () => {
    const a = app(),
      admin = await actor(a, true)
    const { id, owner } = await deletedTeam(a)
    await a.db
      .$client`insert into notification (id,user_id,workspace_id,type,title) values (${newId()},${owner.id},${id},'test','expired')`
    await a.db
      .$client`insert into invitation (id,organization_id,email,inviter_id,status,expires_at)
      values (${newId()},${id},'expired@example.test',${owner.id},'canceled',now())`
    await a.db.$client`update organization set deleted_at=now()-interval '31 days' where id=${id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'WORKSPACE_RETENTION_EXPIRED',
    })
    expect((await cleanupExpiredWorkspaces(a.db)).cleaned).toBeGreaterThanOrEqual(1)
    expect(await cleanupExpiredWorkspaces(a.db)).toEqual({ cleaned: 0 })
    expect(
      await a.db.query.notification.findFirst({ where: (n, { eq }) => eq(n.workspaceId, id) }),
    ).toBeUndefined()
    expect(
      await a.db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.organizationId, id) }),
    ).toBeUndefined()
    expect(
      await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }),
    ).toBeTruthy()
    expect(
      await a.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, owner.id) }),
    ).toBeTruthy()
    const audit = await a.db.query.auditLog.findMany({
      where: (l, { eq }) => eq(l.workspaceId, id),
    })
    expect(audit.map((l) => l.action).sort()).toEqual([
      'workspace.cleanup.completed',
      'workspace.deleted',
    ])
    await a.db.$client`update organization set deleted_at=now() where id=${id}`
    await expect(restoreWorkspace({ ...admin.options, workspaceId: id })).rejects.toMatchObject({
      code: 'WORKSPACE_RETENTION_EXPIRED',
    })
  })
})
