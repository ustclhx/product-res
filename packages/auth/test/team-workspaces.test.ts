import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieHeader, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('teams')
beforeAll(() => users.start())
afterAll(() => users.cleanup())
async function actor(app: ReturnType<typeof setup>, name: string) {
  const address = users.email(name)
  const response = await app.post('/sign-up/email', signUpBody(address))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  // Role/seat tests seed verified recipients; signup cookies still contain emailVerified=false.
  await app.db.$client`update "user" set email_verified=true where id=${user.id}`
  return { id: user.id, email: address, cookie: cookieHeader(response) }
}
async function team(app: ReturnType<typeof setup>, cookie: string, suffix: string) {
  const response = await app.post(
    '/organization/create',
    { name: 'Team', slug: `team-${suffix}-${Date.now()}` },
    { cookie },
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { id: string }
  users.createdOrgs.push(body.id)
  return body.id
}
describe('native organization admission', () => {
  it('blocks owner invitation impersonation via native listing until actual mailbox verification', async () => {
    const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
    const owner = await actor(app, 'mailbox-owner')
    const member = await actor(app, 'mailbox-member')
    const organizationId = await team(app, owner.cookie, 'mailbox')
    expect(
      (
        await app.post(
          '/organization/add-member',
          { organizationId, userId: member.id, role: 'member' },
          { cookie: owner.cookie },
        )
      ).status,
    ).toBe(200)
    const address = users.email('impersonated-recipient')
    const invitation = await app.post(
      '/organization/invite-member',
      { organizationId, email: address, role: 'owner' },
      { cookie: owner.cookie },
    )
    expect(invitation.status).toBe(200)
    const listing = await app.get(
      `/organization/list-invitations?organizationId=${organizationId}`,
      {
        cookie: member.cookie,
      },
    )
    expect(listing.status).toBe(200)
    const pending = ((await listing.json()) as { id: string; email: string; role: string }[]).find(
      (i) => i.email === address,
    )
    expect(pending).toMatchObject({ role: 'owner' })
    const signup = await app.post('/sign-up/email', signUpBody(address))
    expect(signup.status).toBe(200)
    const { user: recipient } = (await signup.json()) as {
      user: { id: string; emailVerified: boolean }
    }
    expect(recipient.emailVerified).toBe(false)
    const login = await app.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(login.status).toBe(200)
    const cookie = cookieHeader(login)
    const before = await app.db.query.member.findMany({
      where: (m, { eq }) => eq(m.organizationId, organizationId),
    })
    const invitationBefore = await app.db.query.invitation.findFirst({
      where: (i, { eq }) => eq(i.id, pending?.id ?? ''),
    })
    const denied = await app.post(
      '/organization/accept-invitation',
      { invitationId: pending?.id },
      { cookie },
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'INVITATION_EMAIL_UNVERIFIED',
      message: 'Verify your email before accepting an invitation',
    })
    expect(
      await app.db.query.member.findMany({
        where: (m, { eq }) => eq(m.organizationId, organizationId),
      }),
    ).toEqual(before)
    expect(
      await app.db.query.invitation.findFirst({
        where: (i, { eq }) => eq(i.id, pending?.id ?? ''),
      }),
    ).toEqual(invitationBefore)
    expect(
      (
        await app.post(
          '/send-verification-email',
          { email: address, callbackURL: '/app' },
          { cookie },
        )
      ).status,
    ).toBe(200)
    const mail = app.sent.find((m) => m.type === 'verify-email' && m.to === address)
    expect(mail?.type).toBe('verify-email')
    if (mail?.type !== 'verify-email') throw new Error('Verification email missing')
    expect((await app.get(mail.url)).status).toBe(302)
    // The original signed cookie still claims an unverified email; DB verification permits admission.
    const accepted = await app.post(
      '/organization/accept-invitation',
      { invitationId: pending?.id },
      { cookie },
    )
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      member: { userId: recipient.id, role: 'owner' },
      invitation: { status: 'accepted' },
    })
  })

  it.each(['member', 'admin', 'owner'] as const)(
    'requires current DB verification for %s admission despite a verified signed cookie',
    async (role) => {
      const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
      const owner = await actor(app, `cached-${role}-owner`)
      const guest = await actor(app, `cached-${role}-guest`)
      const organizationId = await team(app, owner.cookie, `cached-${role}`)
      const login = await app.post('/sign-in/email', { email: guest.email, password: PASSWORD })
      expect(login.status).toBe(200)
      expect(await login.clone().json()).toMatchObject({ user: { emailVerified: true } })
      const verifiedCookie = cookieHeader(login)
      expect(verifiedCookie).toContain('session_data=')
      const invitation = await app.post(
        '/organization/invite-member',
        { organizationId, email: guest.email, role },
        { cookie: owner.cookie },
      )
      expect(invitation.status).toBe(200)
      const { id } = (await invitation.json()) as { id: string }
      await app.db.$client`update "user" set email_verified=false where id=${guest.id}`
      const denied = await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: verifiedCookie },
      )
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ code: 'INVITATION_EMAIL_UNVERIFIED' })
      expect(
        await app.db.query.member.findMany({
          where: (m, { eq }) => eq(m.organizationId, organizationId),
        }),
      ).toHaveLength(1)
      expect(
        await app.db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.id, id) }),
      ).toMatchObject({ status: 'pending' })
      await app.db.$client`update "user" set email_verified=true where id=${guest.id}`
      const accepted = await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: guest.cookie },
      )
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ member: { role } })
    },
  )

  it('disables every team write while preserving existing team reads', async () => {
    const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
    const owner = await actor(app, 'owner')
    const organizationId = await team(app, owner.cookie, 'read')
    const off = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: false } } })
    expect((await off.get('/organization/list', { cookie: owner.cookie })).status).toBe(200)
    for (const path of [
      'create',
      'invite-member',
      'accept-invitation',
      'cancel-invitation',
      'update',
      'remove-member',
      'update-member-role',
      'leave',
      'transfer-owner',
    ]) {
      const response = await off.post(
        `/organization/${path}`,
        {
          name: 'Other',
          slug: 'other-team',
          organizationId,
          invitationId: owner.id,
          memberId: owner.id,
          memberIdOrEmail: owner.id,
          role: 'admin',
          data: { name: 'Changed' },
        },
        { cookie: owner.cookie },
      )
      expect(response.status, path).toBe(403)
    }
  })
  it('rejects personal membership changes and reserved slugs', async () => {
    const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
    const owner = await actor(app, 'personal')
    expect(
      (
        await app.post(
          '/organization/invite-member',
          { organizationId: owner.id, email: users.email('guest'), role: 'member' },
          { cookie: owner.cookie },
        )
      ).status,
    ).toBe(403)
    for (const slug of ['admin', 'api', 'app', 'Bad_Name', 'u-personal']) {
      expect(
        (await app.post('/organization/create', { name: 'Team', slug }, { cookie: owner.cookie }))
          .status,
      ).toBe(400)
    }
  })
  it('serializes concurrent owned-workspace creation', async () => {
    const app = setup({
      config: {
        auth: { turnstile: false },
        tenancy: { multiTenant: true, maxWorkspacesPerUser: 1 },
      },
    })
    const owner = await actor(app, 'limit')
    const responses = await Promise.all(
      ['one', 'two'].map((suffix) =>
        app.post(
          '/organization/create',
          { name: 'Team', slug: `limit-${suffix}-${Date.now()}` },
          { cookie: owner.cookie },
        ),
      ),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403])
    for (const response of responses)
      if (response.status === 200)
        users.createdOrgs.push(((await response.json()) as { id: string }).id)
  })
  it('allows only one concurrent acceptance of the final seat', async () => {
    const app = setup({
      config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
      maxSeats: 2,
    })
    const owner = await actor(app, 'seat-owner')
    const one = await actor(app, 'one')
    const two = await actor(app, 'two')
    const organizationId = await team(app, owner.cookie, 'seat')
    const invitations: string[] = []
    for (const guest of [one, two]) {
      const response = await app.post(
        '/organization/invite-member',
        { organizationId, email: guest.email, role: 'member' },
        { cookie: owner.cookie },
      )
      expect(response.status).toBe(200)
      invitations.push(((await response.json()) as { id: string }).id)
    }
    expect(app.sent.filter((m) => m.type === 'invitation')).toHaveLength(2)
    const results = await Promise.all(
      [one, two].map((guest, index) =>
        app.post(
          '/organization/accept-invitation',
          { invitationId: invitations[index] },
          { cookie: guest.cookie },
        ),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 403])
    expect(
      (
        await app.post(
          '/organization/invite-member',
          { organizationId, email: users.email('full'), role: 'member' },
          { cookie: owner.cookie },
        )
      ).status,
    ).toBe(403)
  })
})

it('enforces roles, recipient identity, cancellation, last-owner and atomic transfer', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
  const owner = await actor(app, 'matrix-owner')
  const admin = await actor(app, 'matrix-admin')
  const member = await actor(app, 'matrix-member')
  const outsider = await actor(app, 'matrix-outsider')
  const organizationId = await team(app, owner.cookie, 'matrix')
  for (const [guest, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ] as const) {
    const invitation = await app.post(
      '/organization/invite-member',
      { organizationId, email: guest.email, role },
      { cookie: owner.cookie },
    )
    const { id } = (await invitation.json()) as { id: string }
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: outsider.cookie },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: guest.cookie },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: guest.cookie },
        )
      ).status,
    ).toBe(403)
  }
  const memberships = await app.db.query.member.findMany({
    where: (m, { eq }) => eq(m.organizationId, organizationId),
  })
  const ownerMember = memberships.find((m) => m.userId === owner.id)
  const adminMember = memberships.find((m) => m.userId === admin.id)
  const memberRow = memberships.find((m) => m.userId === member.id)
  expect(
    (
      await app.post(
        '/organization/add-member',
        { organizationId, userId: outsider.id, role: 'member' },
        { cookie: member.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: memberRow?.id },
        { cookie: member.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: ownerMember?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/update-member-role',
        { organizationId, memberId: memberRow?.id, role: 'owner' },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (await app.post('/organization/leave', { organizationId }, { cookie: owner.cookie })).status,
  ).toBe(403)
  const invitation = await app.post(
    '/organization/invite-member',
    { organizationId, email: outsider.email, role: 'member' },
    { cookie: admin.cookie },
  )
  const { id } = (await invitation.json()) as { id: string }
  expect(
    (
      await app.post(
        '/organization/cancel-invitation',
        { invitationId: id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: outsider.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/transfer-owner',
        { organizationId, memberId: adminMember?.id },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(200)
  const transferred = await app.db.query.member.findMany({
    where: (m, { eq }) => eq(m.organizationId, organizationId),
  })
  expect(transferred.find((m) => m.userId === owner.id)?.role).toBe('admin')
  expect(transferred.find((m) => m.userId === admin.id)?.role).toBe('owner')
  const audits = await app.db.query.auditLog.findMany({
    where: (a, { eq }) => eq(a.workspaceId, organizationId),
  })
  expect(audits.map((a) => a.action)).toEqual(
    expect.arrayContaining([
      'workspace.member_added',
      'workspace.member_invited',
      'workspace.invitation_canceled',
      'workspace.member_role_changed',
    ]),
  )
  const promoted = audits.find(
    (a) => a.targetId === adminMember?.id && a.action === 'workspace.member_role_changed',
  )
  expect(promoted).toMatchObject({
    actorUserId: owner.id,
    ip: app.ip,
    meta: { targetUserId: admin.id, oldRole: 'admin', newRole: 'owner' },
  })

  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: memberRow?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  expect(
    await app.db.query.auditLog.findMany({
      where: (a, { and, eq }) =>
        and(eq(a.workspaceId, organizationId), eq(a.action, 'workspace.member_removed')),
    }),
  ).toMatchObject([
    { actorUserId: admin.id, targetId: memberRow?.id, meta: { oldRole: 'member', newRole: null } },
  ])
  expect(
    (
      await app.get(`/organization/get-full-organization?organizationId=${organizationId}`, {
        cookie: member.cookie,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId: outsider.id, memberIdOrEmail: adminMember?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(404)
})

it('rejects expired invitations and server-only native admission bypasses', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
  const owner = await actor(app, 'expiry-owner')
  const guest = await actor(app, 'expiry-guest')
  const organizationId = await team(app, owner.cookie, 'expiry')
  const response = await app.post(
    '/organization/invite-member',
    { organizationId, email: guest.email, role: 'member' },
    { cookie: owner.cookie },
  )
  const { id } = (await response.json()) as { id: string }
  await app.db.$client`update invitation set expires_at=now()-interval '1 second' where id=${id}`
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: guest.cookie },
      )
    ).status,
  ).toBe(403)
  await expect(
    app.auth.api.addMember({ body: { organizationId, userId: guest.id, role: 'member' } }),
  ).rejects.toMatchObject({ status: 'FORBIDDEN' })
  await expect(
    app.auth.api.createOrganization({
      body: { name: 'Bypass', slug: 'bypass-team', userId: owner.id },
    }),
  ).rejects.toMatchObject({ status: 'FORBIDDEN' })
})

it('serializes add-member against acceptance and rejects unauthenticated or protected admission', async () => {
  const app = setup({
    config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
    maxSeats: 2,
  })
  const owner = await actor(app, 'mixed-owner')
  const added = await actor(app, 'mixed-added')
  const invited = await actor(app, 'mixed-invited')
  const organizationId = await team(app, owner.cookie, 'mixed')
  const invitation = await app.post(
    '/organization/invite-member',
    { organizationId, email: invited.email, role: 'member' },
    { cookie: owner.cookie },
  )
  const { id } = (await invitation.json()) as { id: string }
  const body = { organizationId, userId: added.id, role: 'member' }
  expect((await app.post('/organization/add-member', body)).status).toBe(401)
  expect(
    (
      await app.post(
        '/organization/add-member',
        { ...body, organizationId: owner.id },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(403)
  const off = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: false } } })
  expect((await off.post('/organization/add-member', body, { cookie: owner.cookie })).status).toBe(
    403,
  )
  const results = await Promise.all([
    app.post('/organization/add-member', body, { cookie: owner.cookie }),
    app.post('/organization/accept-invitation', { invitationId: id }, { cookie: invited.cookie }),
  ])
  expect(results.map((r) => r.status).sort()).toEqual([200, 403])
  const members = await app.db.query.member.findMany({
    where: (m, { eq }) => eq(m.organizationId, organizationId),
  })
  expect(members).toHaveLength(2)
})

it('allows additional owners while enforcing grantor role and new-owner workspace limits', async () => {
  const app = setup({
    config: { auth: { turnstile: false }, tenancy: { multiTenant: true, maxWorkspacesPerUser: 1 } },
  })
  const owner = await actor(app, 'grant-owner')
  const admin = await actor(app, 'grant-admin')
  const guest = await actor(app, 'grant-guest')
  const limited = await actor(app, 'grant-limited')
  const extra = await actor(app, 'grant-extra')
  const organizationId = await team(app, owner.cookie, 'grant')
  await team(app, limited.cookie, 'limited')
  expect(
    (
      await app.post(
        '/organization/add-member',
        { organizationId, userId: extra.id, role: 'owner' },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(200)
  const add = await app.post(
    '/organization/add-member',
    { organizationId, userId: admin.id, role: 'admin' },
    { cookie: owner.cookie },
  )
  expect(add.status).toBe(200)
  const { member } = (await add.json()) as { member: { id: string } }
  expect(
    (
      await app.post(
        '/organization/add-member',
        { organizationId, userId: guest.id, role: 'owner' },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/invite-member',
        { organizationId, email: guest.email, role: 'owner' },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/add-member',
        { organizationId, userId: limited.id, role: 'owner' },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/update-member-role',
        { organizationId, memberId: member.id, role: 'owner' },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(200)
  const invitation = await app.post(
    '/organization/invite-member',
    { organizationId, email: guest.email, role: 'owner' },
    { cookie: owner.cookie },
  )
  expect(invitation.status).toBe(200)
  const { id } = (await invitation.json()) as { id: string }
  const ownerRow = await app.db.query.member.findFirst({
    where: (m, { and, eq }) => and(eq(m.organizationId, organizationId), eq(m.userId, owner.id)),
  })
  expect(
    (
      await app.post(
        '/organization/update-member-role',
        { organizationId, memberId: ownerRow?.id, role: 'admin' },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: guest.cookie },
      )
    ).status,
  ).toBe(403)
  const replacement = await app.post(
    '/organization/invite-member',
    { organizationId, email: limited.email, role: 'owner' },
    { cookie: admin.cookie },
  )
  const replacementId = ((await replacement.json()) as { id: string }).id
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: replacementId },
        { cookie: limited.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/cancel-invitation',
        { invitationId: id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  const granted = await app.post(
    '/organization/invite-member',
    { organizationId, email: guest.email, role: 'owner' },
    { cookie: admin.cookie },
  )
  const grantedId = ((await granted.json()) as { id: string }).id
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: grantedId },
        { cookie: guest.cookie },
      )
    ).status,
  ).toBe(200)
})

it('updates personal settings with tenancy off and checks slug uniqueness under the update lock', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: false } } })
  const owner = await actor(app, 'profile-owner')
  const other = await actor(app, 'profile-other')
  const slug = `personal-${Date.now()}`
  const response = await app.post(
    '/organization/update',
    { organizationId: owner.id, data: { name: 'Renamed', slug, metadata: { color: 'blue' } } },
    { cookie: owner.cookie },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    id: owner.id,
    name: 'Renamed',
    slug,
    metadata: { color: 'blue' },
  })
  expect(
    (
      await app.post(
        '/organization/update',
        { organizationId: other.id, data: { slug } },
        { cookie: other.cookie },
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await app.post(
        '/organization/update',
        { organizationId: owner.id, data: { slug: 'admin' } },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await app.post(
        '/organization/update',
        { organizationId: owner.id, data: { name: 'Stolen' } },
        { cookie: other.cookie },
      )
    ).status,
  ).toBe(404)
})

it('set-active uses current membership, soft deletion and database session despite cookie cache', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
  const owner = await actor(app, 'active-owner')
  const guest = await actor(app, 'active-guest')
  const organizationId = await team(app, owner.cookie, 'active')
  expect(
    (
      await app.post(
        '/organization/add-member',
        { organizationId, userId: guest.id, role: 'member' },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(200)
  const active = await app.post(
    '/organization/set-active',
    { organizationId },
    { cookie: guest.cookie },
  )
  expect(active.status).toBe(200)
  expect(await active.json()).toMatchObject({ id: organizationId })
  const cached = cookieHeader(active)
  await app.db
    .$client`delete from member where organization_id=${organizationId} and user_id=${guest.id}`
  expect(
    (await app.post('/organization/set-active', { organizationId }, { cookie: cached })).status,
  ).toBe(404)
  await app.db.$client`update organization set deleted_at=now() where id=${organizationId}`
  expect(
    (await app.post('/organization/set-active', { organizationId }, { cookie: owner.cookie }))
      .status,
  ).toBe(404)
  await app.db.$client`delete from session where user_id=${guest.id}`
  expect(
    (await app.post('/organization/set-active', { organizationId: guest.id }, { cookie: cached }))
      .status,
  ).toBe(401)
})
