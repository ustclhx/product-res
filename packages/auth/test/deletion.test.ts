import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import { createCloudflareKv } from '@product-res/platform/cloudflare'
import { newId } from '@product-res/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DELETION_CLEANUP_PREFIX,
  deleteAccount,
  deleteTeamWorkspace,
  registerDeletionStep,
  retryDeletionCleanup,
} from '../src/deletion.ts'
import { requireFreshSession } from '../src/fresh-session.ts'
import {
  cookieHeader,
  PASSWORD,
  setup,
  signUpBody,
  silenceExpectedErrors,
  testUsers,
} from './helpers.ts'

const users = testUsers('deletion')
const deleted: { id: string; email: string }[] = []
const apiKeys: string[] = []
beforeAll(() => users.start())
afterAll(async () => {
  const sql = setup().db.$client
  // audit_log 对 app 只追加，审计行由 migrator 清理
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR).$client
  for (const id of apiKeys) await sql`delete from apikey where id=${id}`
  for (const user of deleted) {
    await migrator`delete from audit_log where actor_user_id=${user.id} or workspace_id=${user.id}`
    await sql`update "user" set email=${users.email('cleanup')} where id=${user.id}`
  }
  for (const id of users.createdOrgs) await migrator`delete from audit_log where workspace_id=${id}`
  await users.cleanup()
})
const app = () =>
  setup({
    rateLimiter: { limit: async () => ({ success: true }) },
    config: { auth: { turnstile: false, magicLink: true }, tenancy: { multiTenant: true } },
  })
async function actor(a: ReturnType<typeof app>, name: string) {
  const email = users.email(name)
  const response = await a.post('/sign-up/email', signUpBody(email))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const cookie = cookieHeader(response)
  return {
    id: user.id,
    email,
    cookie,
    options: {
      auth: a.auth,
      db: a.db,
      headers: new Headers({ cookie }),
      kv: createCloudflareKv(env.CACHE),
      clientIp: a.ip,
    },
  }
}
async function team(a: ReturnType<typeof app>, owner: Awaited<ReturnType<typeof actor>>) {
  const response = await a.post(
    '/organization/create',
    { name: 'Deletion team', slug: `delete-${owner.id}` },
    { cookie: owner.cookie },
  )
  expect(response.status).toBe(200)
  const { id } = (await response.json()) as { id: string }
  users.createdOrgs.push(id)
  return id
}
describe('atomic deletion in workerd', () => {
  it('requires a DB session and recent real login, ignoring updated_at', async () => {
    const a = app()
    const owner = await actor(a, 'old')
    await a.db.$client`update session set impersonated_by=${owner.id} where user_id=${owner.id}`
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    })
    await a.db.$client`update session set impersonated_by=null where user_id=${owner.id}`
    await a.db
      .$client`update session set created_at=now()-interval '1 day',updated_at=now() where user_id=${owner.id}`
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    })
    await a.db.$client`delete from session where user_id=${owner.id}`
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  })
  it('blocks sole owners, then soft deletes a team and resets active sessions', async () => {
    const a = app()
    const owner = await actor(a, 'sole')
    const id = await team(a, owner)
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({
      code: 'SOLE_WORKSPACE_OWNER',
      details: { workspaces: [{ id }] },
    })
    const invite = newId()
    const key = newId()
    apiKeys.push(key)
    await a.db
      .$client`insert into invitation (id,organization_id,email,role,status,expires_at,inviter_id) values (${invite},${id},${users.email('invite')},'member','pending',now()+interval '1 day',${owner.id})`
    await a.db
      .$client`insert into apikey (id,config_id,key,reference_id,metadata) values (${key},'default',${newId()},${owner.id},${JSON.stringify({ workspace_id: id })})`
    await a.db.$client`update session set active_organization_id=${id} where user_id=${owner.id}`
    expect(
      (await a.post('/deletion/workspace', { workspaceId: id }, { cookie: owner.cookie })).status,
    ).toBe(200)
    expect(
      await a.db.query.member.findFirst({ where: (m, { eq }) => eq(m.organizationId, id) }),
    ).toBeUndefined()
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeTruthy()
    expect(
      (await a.db.query.session.findFirst({ where: (s, { eq }) => eq(s.userId, owner.id) }))
        ?.activeOrganizationId,
    ).toBeNull()
    expect(
      (await a.db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.id, invite) }))?.status,
    ).toBe('canceled')
    expect(
      (await a.db.query.apikey.findFirst({ where: (k, { eq }) => eq(k.id, key) }))?.enabled,
    ).toBe(false)
    await expect(deleteTeamWorkspace({ ...owner.options, workspaceId: id })).rejects.toMatchObject({
      status: 404,
    })
  })
  it('anonymizes and removes only owned credentials, invalidates old links, allows new email registration', async () => {
    const a = app()
    const owner = await actor(a, 'credentials')
    const other = await actor(a, 'other')
    await a.post('/email-otp/send-verification-otp', { email: owner.email, type: 'sign-in' })
    const otp = a.sent.find((mail) => mail.type === 'otp' && mail.to === owner.email)
    await a.post('/sign-in/magic-link', { email: owner.email, callbackURL: '/account' })
    const magic = a.sent.find((mail) => mail.type === 'magic-link')
    await a.post('/request-password-reset', { email: owner.email, redirectTo: '/reset-password' })
    const reset = a.sent.find((mail) => mail.type === 'reset-password')
    await a.post('/email-otp/send-verification-otp', { email: other.email, type: 'sign-in' })
    const verification = await a.db.query.verification.findMany()
    deleted.push(owner)
    expect((await a.post('/deletion/account', {}, { cookie: owner.cookie })).status).toBe(200)
    const row = await a.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, owner.id) })
    expect(row).toMatchObject({
      email: `deleted+${owner.id}@invalid`,
      name: '',
      image: null,
      locale: null,
      timezone: null,
      banned: true,
      banExpires: null,
    })
    await expect(requireFreshSession(owner.options)).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
    expect(await env.CACHE.get(`auth:active-sessions-${owner.id}`)).toBeNull()
    expect(
      await a.db.query.account.findFirst({ where: (u, { eq }) => eq(u.userId, owner.id) }),
    ).toBeUndefined()
    expect(
      (await a.post('/sign-in/email', { email: owner.email, password: PASSWORD })).status,
    ).not.toBe(200)
    const replacement = await a.post('/sign-up/email', signUpBody(owner.email))
    expect(replacement.status).toBe(200)
    expect(((await replacement.json()) as { user: { id: string } }).user.id).not.toBe(owner.id)
    if (otp?.type === 'otp')
      expect(
        (await a.post('/sign-in/email-otp', { email: owner.email, otp: otp.otp })).status,
      ).not.toBe(200)
    if (magic?.type === 'magic-link') {
      const response = await a.get(magic.url)
      expect(response.headers.get('location')).toContain('error=')
    }
    if (reset?.type === 'reset-password') {
      const token = new URL(reset.url).pathname.split('/').at(-1)
      expect(
        (await a.post('/reset-password', { token, newPassword: 'ChangedPassword123!' })).status,
      ).not.toBe(200)
    }
    const otherVerification = verification.find(
      (v) => v.identifier === `sign-in-otp-${other.email}`,
    )
    expect(otherVerification).toBeTruthy()
    expect(
      await a.db.query.verification.findFirst({
        where: (v, { eq }) => eq(v.id, otherVerification?.id ?? ''),
      }),
    ).toBeTruthy()
  })
  it('lets one of multiple owners leave without deleting the team', async () => {
    const a = app()
    const owner = await actor(a, 'multiple')
    const other = await actor(a, 'remaining')
    const id = await team(a, owner)
    await a.db
      .$client`insert into member (id,organization_id,user_id,role) values (${other.id},${id},${other.id},'owner')`
    deleted.push(owner)
    await deleteAccount(owner.options)
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeNull()
    expect(
      (await a.db.query.member.findMany({ where: (m, { eq }) => eq(m.organizationId, id) })).map(
        (m) => m.userId,
      ),
    ).toEqual([other.id])
  })
  it('runs hooks in order and rolls back when execution refuses', async () => {
    const a = app()
    const owner = await actor(a, 'hooks')
    const id = await team(a, owner)
    const calls: string[] = []
    const dispose = registerDeletionStep('workspace', {
      before: async () => {
        calls.push('before')
      },
      execute: async () => {
        calls.push('execute')
        throw new Error('blocked')
      },
    })
    try {
      await expect(deleteTeamWorkspace({ ...owner.options, workspaceId: id })).rejects.toThrow(
        'blocked',
      )
    } finally {
      dispose()
    }
    expect(calls).toEqual(['before', 'execute'])
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeNull()
  })
  it('keeps native deletion disabled and enforces owner, personal and tenancy boundaries', async () => {
    silenceExpectedErrors(/Delete user is disabled/)
    const a = app()
    const owner = await actor(a, 'boundaries')
    const other = await actor(a, 'not-owner')
    const id = await team(a, owner)
    expect(
      (await a.post('/deletion/workspace', { workspaceId: id }, { cookie: other.cookie })).status,
    ).toBe(403)
    expect(
      (await a.post('/deletion/workspace', { workspaceId: owner.id }, { cookie: owner.cookie }))
        .status,
    ).toBe(403)
    expect((await a.post('/delete-user', {}, { cookie: owner.cookie })).status).not.toBe(200)
    expect(
      (await a.post('/organization/delete', { organizationId: id }, { cookie: owner.cookie }))
        .status,
    ).not.toBe(200)
    const off = setup({
      db: a.db,
      rateLimiter: { limit: async () => ({ success: true }) },
      config: { auth: { turnstile: false }, tenancy: { multiTenant: false } },
    })
    expect(
      (await off.post('/deletion/workspace', { workspaceId: id }, { cookie: owner.cookie })).status,
    ).toBe(403)
    await expect(
      deleteTeamWorkspace({ ...owner.options, workspaceId: id, multiTenant: false }),
    ).rejects.toMatchObject({ code: 'TEAM_WORKSPACES_DISABLED' })
    deleted.push(other)
    expect((await off.post('/deletion/account', {}, { cookie: other.cookie })).status).toBe(200)
  })
  it('persists failed invalidation, rejects stale challenges and preserves replacement challenges on retry', async () => {
    let fail = false
    const kv = {
      ...createCloudflareKv(env.CACHE),
      delete: async (key: string) => {
        if (fail) throw new Error('KV unavailable')
        await env.CACHE.delete(key)
      },
    }
    const a = setup({
      cache: kv,
      rateLimiter: { limit: async () => ({ success: true }) },
      config: { auth: { turnstile: false, magicLink: true }, tenancy: { multiTenant: true } },
    })
    const owner = await actor(a, 'retry')
    await a.post('/email-otp/send-verification-otp', { email: owner.email, type: 'sign-in' })
    await a.post('/sign-in/magic-link', { email: owner.email, callbackURL: '/account' })
    await a.post('/request-password-reset', { email: owner.email, redirectTo: '/reset-password' })
    const otp = a.sent.find((mail) => mail.type === 'otp')
    const magic = a.sent.find((mail) => mail.type === 'magic-link')
    const reset = a.sent.find((mail) => mail.type === 'reset-password')
    expect(otp?.type).toBe('otp')
    expect(magic?.type).toBe('magic-link')
    expect(reset?.type).toBe('reset-password')
    const oldRows = await a.db.query.verification.findMany()
    for (const row of oldRows)
      await env.CACHE.put(`auth:verification:${row.identifier}`, JSON.stringify(row))
    deleted.push(owner)
    fail = true
    const response = await a.post('/deletion/account', {}, { cookie: owner.cookie })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ deletionCompleted: true })
    expect(
      (await a.db.query.verification.findMany()).some((v) =>
        v.identifier.startsWith(DELETION_CLEANUP_PREFIX),
      ),
    ).toBe(true)
    expect(await retryDeletionCleanup(a.db, kv)).toMatchObject({ failed: 1 })
    expect((await a.post('/sign-up/email', signUpBody(owner.email))).status).toBe(200)
    if (otp?.type === 'otp')
      expect(
        (await a.post('/sign-in/email-otp', { email: owner.email, otp: otp.otp })).status,
      ).not.toBe(200)
    if (magic?.type === 'magic-link')
      expect((await a.get(magic.url)).headers.get('location')).toContain('error=')
    if (reset?.type === 'reset-password')
      expect(
        (
          await a.post('/reset-password', {
            token: new URL(reset.url).pathname.split('/').at(-1),
            newPassword: 'ChangedPassword123!',
          })
        ).status,
      ).not.toBe(200)
    expect(
      (await a.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, owner.email) }))
        ?.emailVerified,
    ).toBe(false)
    await a.post('/email-otp/send-verification-otp', { email: owner.email, type: 'sign-in' })
    const replacement = a.sent.filter((mail) => mail.type === 'otp').at(-1)
    const row = await a.db.query.verification.findFirst({
      where: (v, { eq }) => eq(v.identifier, `sign-in-otp-${owner.email}`),
    })
    expect(row).toBeTruthy()
    // Simulate a newer cached value. Retry must never delete this reusable email key.
    await env.CACHE.put(`auth:verification:${row?.identifier}`, JSON.stringify(row))
    fail = false
    expect(await retryDeletionCleanup(a.db, kv)).toEqual({ completed: 1, failed: 0 })
    expect(await env.CACHE.get(`auth:verification:${row?.identifier}`)).not.toBeNull()
    expect(await retryDeletionCleanup(a.db, kv)).toEqual({ completed: 0, failed: 0 })
    if (replacement?.type === 'otp')
      expect(
        (await a.post('/sign-in/email-otp', { email: owner.email, otp: replacement.otp })).status,
      ).toBe(200)
  })
  it('refuses before hooks without invoking execution or changing workspace', async () => {
    const a = app()
    const owner = await actor(a, 'before-hook')
    const id = await team(a, owner)
    let executed = false
    const dispose = registerDeletionStep('workspace', {
      before: async () => {
        throw new Error('provider refused')
      },
      execute: async () => {
        executed = true
      },
    })
    try {
      await expect(deleteTeamWorkspace({ ...owner.options, workspaceId: id })).rejects.toThrow(
        'provider refused',
      )
    } finally {
      dispose()
    }
    expect(executed).toBe(false)
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeNull()
  })
  it('serializes ownership grant against account deletion', async () => {
    const a = app()
    const owner = await actor(a, 'race-owner')
    const target = await actor(a, 'race-target')
    const id = await team(a, owner)
    const memberId = newId()
    await a.db
      .$client`insert into member (id,organization_id,user_id,role) values (${memberId},${id},${target.id},'member')`
    const [grant, deletion] = await Promise.all([
      a.post(
        '/organization/transfer-owner',
        { organizationId: id, memberId, role: 'owner' },
        { cookie: owner.cookie },
      ),
      a.post('/deletion/account', {}, { cookie: target.cookie }),
    ])
    expect(grant.status === 200 && deletion.status === 200).toBe(false)
    if (deletion.status === 200) {
      deleted.push(target)
      expect(
        await a.db.query.member.findFirst({ where: (m, { eq }) => eq(m.userId, target.id) }),
      ).toBeUndefined()
    } else {
      expect(grant.status).toBe(200)
      expect(await deletion.json()).toMatchObject({ code: 'SOLE_WORKSPACE_OWNER' })
    }
  })
})
