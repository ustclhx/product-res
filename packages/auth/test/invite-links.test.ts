import { defineTemplateConfig } from '@product-res/config'
import { AppError } from '@product-res/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createInviteLink,
  deleteTeamWorkspace,
  type InviteLinkActor,
  type InviteLinkDeps,
  joinWithInviteLink,
  listInviteLinks,
  previewInviteLink,
  revokeInviteLink,
} from '../src/index.ts'
import { hashInviteLinkToken } from '../src/invite-links.ts'
import {
  app as appConfig,
  cookieHeader,
  migratorDb,
  setup,
  signUpBody,
  testUsers,
} from './helpers.ts'

// add-team-invite-links 3.2：邀请链接的生成、状态、加入、席位并发与权限。
const users = testUsers('invite-links')
beforeAll(() => users.start())
afterAll(() => users.cleanup())

const http = setup({
  config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
  rateLimiter: undefined,
})
const migrator = migratorDb()
const config = defineTemplateConfig({ app: appConfig, tenancy: { multiTenant: true } })
const deps = (maxSeats: number | null = null): InviteLinkDeps => ({
  db: http.db,
  config,
  resolveMaxSeats: async () => maxSeats,
})

async function person(name: string) {
  const email = users.email(name)
  const response = await http.post('/sign-up/email', signUpBody(email))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const [session] = await http.db.$client<
    { id: string }[]
  >`select id from session where user_id=${user.id} order by created_at desc limit 1`
  if (!session) throw new Error('session missing')
  return {
    id: user.id,
    cookie: cookieHeader(response),
    actor: { userId: user.id, sessionId: session.id, clientIp: '198.51.100.9' } as InviteLinkActor,
  }
}

async function team(owner: Awaited<ReturnType<typeof person>>, suffix: string) {
  const response = await http.post(
    '/organization/create',
    { name: `Link Team ${suffix}`, slug: `link-${suffix}-${Date.now()}` },
    { cookie: owner.cookie },
  )
  expect(response.status).toBe(200)
  const { id } = (await response.json()) as { id: string }
  users.createdOrgs.push(id)
  return id
}

async function code(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, status: error.status }
    throw error
  }
  return null
}

const roleOf = async (workspaceId: string, userId: string) =>
  (
    await http.db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, workspaceId), eq(m.userId, userId)),
    })
  )?.role

describe('team invite links', () => {
  it('creates a hashed link, joins with its role and records audit without the token', async () => {
    const owner = await person('owner')
    const guest = await person('guest')
    const workspaceId = await team(owner, 'basic')
    const { link, token } = await createInviteLink(deps(), owner.actor, {
      workspaceId,
      role: 'admin',
      ttlDays: 7,
      maxUses: 3,
    })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(link).toMatchObject({ role: 'admin', status: 'active', usedCount: 0, maxUses: 3 })
    const expires = new Date(link.expiresAt).getTime() - Date.now()
    expect(expires).toBeGreaterThan(6.9 * 86_400_000)
    expect(expires).toBeLessThanOrEqual(7 * 86_400_000)
    const [row] = await http.db.$client<
      { token_hash: string }[]
    >`select token_hash from workspace_invite_link where id=${link.id}`
    expect(row?.token_hash).toBe(await hashInviteLinkToken(token))
    expect(JSON.stringify(row)).not.toContain(token)

    expect(await previewInviteLink(deps(), guest.id, token)).toMatchObject({
      status: 'valid',
      role: 'admin',
      workspace: { id: workspaceId },
    })
    const joined = await joinWithInviteLink(deps(), guest.actor, token)
    expect(joined).toMatchObject({ role: 'admin', alreadyMember: false })
    expect(await roleOf(workspaceId, guest.id)).toBe('admin')

    // 已是成员：直接返回空间，不消耗次数
    expect(await previewInviteLink(deps(), guest.id, token)).toMatchObject({ status: 'member' })
    expect(await joinWithInviteLink(deps(), guest.actor, token)).toMatchObject({
      alreadyMember: true,
    })
    const [listed] = await listInviteLinks(deps(), owner.id, workspaceId)
    expect(listed).toMatchObject({ id: link.id, usedCount: 1, createdBy: { id: owner.id } })

    const audits = await migrator.$client<
      { action: string; meta: Record<string, unknown> }[]
    >`select action,meta from audit_log where workspace_id=${workspaceId} order by id`
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['workspace.invite_link_created', 'workspace.member_added']),
    )
    expect(audits.find((a) => a.meta.inviteLinkId === link.id)?.meta).toMatchObject({
      newRole: 'admin',
      targetUserId: guest.id,
    })
    expect(JSON.stringify(audits)).not.toContain(token)
  })

  it('rejects expired, revoked, exhausted and unknown links with distinct codes', async () => {
    const owner = await person('states-owner')
    const [a, b, c] = await Promise.all([person('a'), person('b'), person('c')])
    const workspaceId = await team(owner, 'states')
    const make = (maxUses: number | null = null) =>
      createInviteLink(deps(), owner.actor, { workspaceId, role: 'member', ttlDays: 1, maxUses })

    const expired = await make()
    await http.db
      .$client`update workspace_invite_link set expires_at=now()-interval '1 second' where id=${expired.link.id}`
    expect(await previewInviteLink(deps(), a.id, expired.token)).toEqual({ status: 'expired' })
    expect(await code(joinWithInviteLink(deps(), a.actor, expired.token))).toEqual({
      code: 'INVITE_LINK_EXPIRED',
      status: 410,
    })

    const revoked = await make()
    expect(
      await revokeInviteLink(deps(), owner.actor, { workspaceId, linkId: revoked.link.id }),
    ).toMatchObject({ status: 'revoked' })
    expect(await code(joinWithInviteLink(deps(), a.actor, revoked.token))).toMatchObject({
      code: 'INVITE_LINK_REVOKED',
    })

    const single = await make(1)
    await joinWithInviteLink(deps(), b.actor, single.token)
    expect(await previewInviteLink(deps(), c.id, single.token)).toEqual({ status: 'exhausted' })
    expect(await code(joinWithInviteLink(deps(), c.actor, single.token))).toMatchObject({
      code: 'INVITE_LINK_EXHAUSTED',
    })

    const unknown = 'A'.repeat(43)
    expect(await previewInviteLink(deps(), a.id, unknown)).toEqual({ status: 'invalid' })
    expect(await previewInviteLink(deps(), a.id, 'short')).toEqual({ status: 'invalid' })
    expect(await code(joinWithInviteLink(deps(), a.actor, unknown))).toMatchObject({
      code: 'INVITE_LINK_INVALID',
      status: 404,
    })
    expect(await roleOf(workspaceId, a.id)).toBeUndefined()
    expect(await roleOf(workspaceId, c.id)).toBeUndefined()
  })

  it('enforces manager permission, team-only links, member/admin roles and the tenancy flag', async () => {
    const owner = await person('perm-owner')
    const member = await person('perm-member')
    const workspaceId = await team(owner, 'perm')
    const { token } = await createInviteLink(deps(), owner.actor, {
      workspaceId,
      role: 'member',
      ttlDays: 30,
      maxUses: null,
    })
    await joinWithInviteLink(deps(), member.actor, token)
    expect(await roleOf(workspaceId, member.id)).toBe('member')

    const input = { workspaceId, role: 'member' as const, ttlDays: 7 as const, maxUses: null }
    expect(await code(createInviteLink(deps(), member.actor, input))).toEqual({
      code: 'WORKSPACE_PERMISSION',
      status: 403,
    })
    expect(await code(listInviteLinks(deps(), member.id, workspaceId))).toMatchObject({
      code: 'WORKSPACE_PERMISSION',
    })
    // 个人空间 ID 即用户 ID
    expect(
      await code(createInviteLink(deps(), owner.actor, { ...input, workspaceId: owner.id })),
    ).toMatchObject({ code: 'PERSONAL_WORKSPACE', status: 403 })
    expect(
      await code(
        createInviteLink(deps(), owner.actor, { ...input, role: 'owner' as never, ttlDays: 7 }),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT', status: 400 })
    expect(
      await code(createInviteLink(deps(), owner.actor, { ...input, ttlDays: 3 as never })),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    const outsider = await person('perm-outsider')
    expect(await code(createInviteLink(deps(), outsider.actor, input))).toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
      status: 404,
    })

    const disabled: InviteLinkDeps = {
      ...deps(),
      config: defineTemplateConfig({ app: appConfig, tenancy: { multiTenant: false } }),
    }
    expect(await code(createInviteLink(disabled, owner.actor, input))).toMatchObject({
      code: 'WORKSPACE_READ_ONLY',
    })
    expect(await previewInviteLink(disabled, outsider.id, token)).toEqual({ status: 'disabled' })
    expect(await code(joinWithInviteLink(disabled, outsider.actor, token))).toMatchObject({
      code: 'WORKSPACE_READ_ONLY',
    })
  })

  it('invalidates links when the creator loses manager rights or the session is revoked', async () => {
    const owner = await person('creator-owner')
    const admin = await person('creator-admin')
    const guest = await person('creator-guest')
    const workspaceId = await team(owner, 'creator')
    const adminLink = await createInviteLink(deps(), owner.actor, {
      workspaceId,
      role: 'admin',
      ttlDays: 7,
      maxUses: null,
    })
    await joinWithInviteLink(deps(), admin.actor, adminLink.token)
    const { token, link } = await createInviteLink(deps(), admin.actor, {
      workspaceId,
      role: 'member',
      ttlDays: 7,
      maxUses: null,
    })
    await http.db
      .$client`update member set role='member' where organization_id=${workspaceId} and user_id=${admin.id}`
    expect(await previewInviteLink(deps(), guest.id, token)).toEqual({ status: 'inactive' })
    expect(await code(joinWithInviteLink(deps(), guest.actor, token))).toMatchObject({
      code: 'INVITE_LINK_INACTIVE',
    })
    expect(
      (await listInviteLinks(deps(), owner.id, workspaceId)).find((l) => l.id === link.id),
    ).toMatchObject({ status: 'inactive' })

    await http.db.$client`delete from session where id=${guest.actor.sessionId}`
    expect(await code(joinWithInviteLink(deps(), guest.actor, adminLink.token))).toMatchObject({
      code: 'SESSION_REQUIRED',
      status: 401,
    })
  })

  it('admits only one concurrent join for the final seat', async () => {
    const owner = await person('seat-owner')
    const [one, two] = await Promise.all([person('seat-one'), person('seat-two')])
    const workspaceId = await team(owner, 'seat')
    const { token, link } = await createInviteLink(deps(2), owner.actor, {
      workspaceId,
      role: 'member',
      ttlDays: 7,
      maxUses: null,
    })
    const results = await Promise.all(
      [one, two].map((guest) => code(joinWithInviteLink(deps(2), guest.actor, token))),
    )
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r !== null)).toEqual([{ code: 'SEATS_FULL', status: 403 }])
    const members = await http.db.query.member.findMany({
      where: (m, { eq }) => eq(m.organizationId, workspaceId),
    })
    expect(members).toHaveLength(2)
    const [row] = await http.db.$client<
      { used_count: number }[]
    >`select used_count from workspace_invite_link where id=${link.id}`
    expect(row?.used_count).toBe(1)
  })

  it('caps concurrent joins by the link usage limit', async () => {
    const owner = await person('cap-owner')
    const guests = await Promise.all([person('cap-1'), person('cap-2'), person('cap-3')])
    const workspaceId = await team(owner, 'cap')
    const { token } = await createInviteLink(deps(), owner.actor, {
      workspaceId,
      role: 'member',
      ttlDays: 7,
      maxUses: 2,
    })
    const results = await Promise.all(
      guests.map((guest) => code(joinWithInviteLink(deps(), guest.actor, token))),
    )
    expect(results.filter((r) => r === null)).toHaveLength(2)
    expect(results.filter((r) => r !== null)).toEqual([
      { code: 'INVITE_LINK_EXHAUSTED', status: 410 },
    ])
  })

  it('revokes every link when the team workspace is soft-deleted', async () => {
    const owner = await person('delete-owner')
    const guest = await person('delete-guest')
    const workspaceId = await team(owner, 'delete')
    const { token, link } = await createInviteLink(deps(), owner.actor, {
      workspaceId,
      role: 'member',
      ttlDays: 7,
      maxUses: null,
    })
    await deleteTeamWorkspace({
      auth: http.auth,
      db: http.db,
      headers: new Headers({ cookie: owner.cookie }),
      workspaceId,
    })
    const [row] = await http.db.$client<
      { revoked_at: Date | null; revoked_by: string | null }[]
    >`select revoked_at,revoked_by from workspace_invite_link where id=${link.id}`
    expect(row?.revoked_at).not.toBeNull()
    expect(row?.revoked_by).toBe(owner.id)
    expect(await previewInviteLink(deps(), guest.id, token)).toEqual({ status: 'invalid' })
  })
})
