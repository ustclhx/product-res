import type { TemplateConfig } from '@product-res/config'
import type { Database } from '@product-res/db'
import { newId } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'
import type { SendAuthEmail } from './email.ts'
import { checkSessionInDatabase } from './fresh-session.ts'

/** Resolve only from local DB using the supplied transaction; never perform network I/O. */
export type ResolveMaxSeats = (
  workspaceId: string,
  sql: Pick<Database['$client'], 'unsafe'>,
) => Promise<number | null>
const roles = z.enum(['owner', 'admin', 'member'])
const uuid = z.uuid()
const slug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const reserved = new Set([
  'admin',
  'api',
  'app',
  'account',
  'login',
  'logout',
  'signup',
  'settings',
  'invite',
  'new',
])
function validSlug(value: unknown): string {
  const parsed = slug.safeParse(value)
  if (!parsed.success || reserved.has(parsed.data) || parsed.data.startsWith('u-')) {
    throw APIError.from('BAD_REQUEST', {
      code: 'INVALID_WORKSPACE_SLUG',
      message: 'Invalid or reserved slug',
    })
  }
  return parsed.data
}
function deny(code: string, message: string): never {
  throw APIError.from('FORBIDDEN', { code, message })
}
function missing(): never {
  throw APIError.from('NOT_FOUND', { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' })
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw APIError.from('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' })
  return result.data
}
const mutations = new Set([
  'create',
  'invite-member',
  'accept-invitation',
  'cancel-invitation',
  'remove-member',
  'update-member-role',
  'leave',
])
const transferInput = z.object({ organizationId: uuid, memberId: uuid })
const readPosts = new Set(['check-slug', 'has-permission'])
const addInput = z.object({ organizationId: uuid, userId: uuid, role: roles.default('member') })

/** Native organization HTTP writes use the same admission checks and SQL transaction. */
export function teamWorkspaces(
  db: Database,
  config: TemplateConfig,
  sendEmail: SendAuthEmail,
  resolveMaxSeats: ResolveMaxSeats = async () => null,
  clientIp?: string | null,
) {
  return {
    id: 'team-workspaces',
    endpoints: {
      addWorkspaceMember: createAuthEndpoint(
        '/organization/add-member',
        { method: 'POST', body: addInput, requireHeaders: true },
        async (ctx) => ctx.json({}),
      ),
      transferWorkspaceOwner: createAuthEndpoint(
        '/organization/transfer-owner',
        { method: 'POST', body: transferInput, requireHeaders: true },
        async (ctx) => ctx.json({}),
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => (ctx.path ?? '').startsWith('/organization/'),
          handler: createAuthMiddleware(async (ctx) => {
            const action = (ctx.path ?? '').slice('/organization/'.length)
            if (action === 'check-slug') validSlug(ctx.body?.slug)
            const write = ctx.method === 'POST' && !readPosts.has(action)
            if (!write) return
            if (!config.tenancy.multiTenant && action !== 'update' && action !== 'set-active')
              deny('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled')
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            )
            const fresh = token ? await checkSessionInDatabase(db, token) : null
            if (!fresh?.ok)
              throw APIError.from('UNAUTHORIZED', {
                code: 'SESSION_REQUIRED',
                message: 'Sign in required',
              })
            const { user, session } = fresh.value
            const body = ctx.body ?? {}
            const auditMember = async (
              sql: Pick<Database['$client'], 'unsafe'>,
              workspaceId: string,
              action: string,
              targetId: string,
              meta: Record<string, unknown>,
            ) => {
              await sql.unsafe(
                'insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,ip,meta) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
                [
                  newId(),
                  user.id,
                  workspaceId,
                  action,
                  'member',
                  targetId,
                  clientIp ?? null,
                  JSON.stringify({ ...meta, impersonatedBy: session.impersonatedBy ?? null }),
                ],
              )
            }
            // Recheck session and ban state after admission locks, using this transaction.
            const checkFresh = async (sql: Pick<Database['$client'], 'unsafe'>) => {
              const rows = await sql.unsafe(
                'select s.id from session s join "user" u on u.id=s.user_id where s.token=$1 and s.user_id=$2 and s.expires_at>now() and not (coalesce(u.banned,false) and (u.ban_expires is null or u.ban_expires>now()))',
                [token, user.id],
              )
              if (!rows.length)
                throw APIError.from('UNAUTHORIZED', {
                  code: 'SESSION_REQUIRED',
                  message: 'Sign in required',
                })
            }
            if (action === 'create') {
              const input = parse(
                z.object({ name: z.string().trim().min(1).max(100), slug: z.string() }),
                body,
              )
              const requestedSlug = validSlug(input.slug)
              const result = await db.$client.begin(async (sql) => {
                await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${user.id}`}, 0))`
                await checkFresh(sql)
                const [count] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member m join organization o on o.id=m.organization_id where m.user_id=${user.id} and m.role='owner' and not o.is_personal and o.deleted_at is null`
                if ((count?.total ?? 0) >= config.tenancy.maxWorkspacesPerUser)
                  deny('WORKSPACE_LIMIT', 'Workspace limit reached')
                // Serialize slug admission too; the database unique constraint remains the final invariant.
                await sql`select pg_advisory_xact_lock(hashtextextended(${`slug:${requestedSlug}`}, 0))`
                if ((await sql`select id from organization where slug=${requestedSlug}`).length)
                  throw APIError.from('BAD_REQUEST', {
                    code: 'SLUG_TAKEN',
                    message: 'Slug already in use',
                  })
                const id = newId()
                const [org] =
                  await sql`insert into organization (id,name,slug,is_personal) values (${id},${input.name},${requestedSlug},false) returning id,name,slug,logo,metadata,is_personal as "isPersonal",deleted_at as "deletedAt",created_at as "createdAt",updated_at as "updatedAt"`
                const [member] =
                  await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${id},${user.id},'owner') returning id,organization_id as "organizationId",user_id as "userId",role,created_at as "createdAt"`
                await auditMember(sql, id, 'workspace.member_added', String(member?.id), {
                  targetUserId: user.id,
                  oldRole: null,
                  newRole: 'owner',
                })
                return { ...org, members: [member] }
              })
              return ctx.json(result)
            }
            let workspaceId = body.organizationId ?? session.activeOrganizationId
            if (action === 'accept-invitation' || action === 'cancel-invitation') {
              const invitationId = parse(uuid, body.invitationId)
              const invitation = await db.query.invitation.findFirst({
                where: (i, { eq }) => eq(i.id, invitationId),
              })
              if (!invitation) missing()
              workspaceId = invitation.organizationId
            }
            if (action === 'set-active' && body.organizationId === null) {
              await db.$client.begin(async (sql) => {
                await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${user.id}`}, 0))`
                await checkFresh(sql)
                await sql`update session set active_organization_id=null,updated_at=now() where id=${session.id}`
              })
              await ctx.context.options.secondaryStorage?.delete(session.token)
              await setSessionCookie(ctx, {
                session: { ...session, activeOrganizationId: null },
                user,
              })
              return ctx.json(null)
            }
            if (action === 'set-active' && body.organizationSlug && !body.organizationId) {
              const org = await db.query.organization.findFirst({
                where: (o, { eq }) => eq(o.slug, body.organizationSlug),
              })
              if (!org) missing()
              workspaceId = org.id
            }
            workspaceId = parse(uuid, workspaceId)
            // Preliminary target lookup only selects lock keys. Authorization is repeated under locks.
            let targetUserId: string | undefined
            if (action === 'add-member') targetUserId = parse(addInput, body).userId
            if (
              action === 'transfer-owner' ||
              action === 'update-member-role' ||
              action === 'remove-member'
            ) {
              const targetKey = body.memberId ?? body.memberIdOrEmail
              const [target] = await db.$client<
                { user_id: string }[]
              >`select m.user_id from member m join "user" u on u.id=m.user_id where m.organization_id=${workspaceId} and (m.id::text=${targetKey ?? ''} or lower(u.email)=lower(${targetKey ?? ''}))`
              targetUserId = target?.user_id
            }
            const result = await db.$client.begin(async (sql) => {
              for (const id of [
                ...new Set([user.id, targetUserId].filter((id): id is string => !!id)),
              ].sort()) {
                await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${id}`}, 0))`
              }
              await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`}, 0))`
              await checkFresh(sql)
              const [workspace] = await sql<
                { id: string; name: string; isPersonal: boolean; deletedAt: string | null }[]
              >`select id,name,is_personal as "isPersonal",deleted_at as "deletedAt" from organization where id=${workspaceId}`
              if (!workspace || workspace.deletedAt) missing()
              const [actor] = await sql<
                { id: string; role: string }[]
              >`select id,role from member where organization_id=${workspaceId} and user_id=${user.id}`
              if (action !== 'accept-invitation' && !actor) missing()
              if (!config.tenancy.multiTenant && !workspace.isPersonal && action !== 'set-active')
                deny('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled')
              if (workspace.isPersonal && action !== 'update' && action !== 'set-active')
                deny('PERSONAL_WORKSPACE', 'Personal workspace membership cannot change')
              const checkSeats = async () => {
                const limit = await resolveMaxSeats(workspaceId, sql)
                const [count] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member where organization_id=${workspaceId}`
                if (limit !== null && (count?.total ?? 0) >= limit)
                  deny('SEATS_FULL', 'Workspace seats are full')
              }
              const checkOwned = async (id: string) => {
                const [available] =
                  await sql`select id from "user" where id=${id} and not (coalesce(banned,false) and (ban_expires is null or ban_expires>now()))`
                if (!available) deny('INVALID_MEMBER', 'User unavailable')
                const [owned] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member m join organization o on o.id=m.organization_id where m.user_id=${id} and m.role='owner' and not o.is_personal and o.deleted_at is null`
                if ((owned?.total ?? 0) >= config.tenancy.maxWorkspacesPerUser)
                  deny('WORKSPACE_LIMIT', 'New owner workspace limit reached')
              }
              if (action === 'set-active') {
                await sql`update session set active_organization_id=${workspaceId},updated_at=now() where id=${session.id}`
                const [org] =
                  await sql`select id,name,slug,logo,metadata,is_personal as "isPersonal",deleted_at as "deletedAt",created_at as "createdAt",updated_at as "updatedAt" from organization where id=${workspaceId}`
                return { ...org, metadata: org?.metadata ? JSON.parse(org.metadata) : null }
              }
              if (action === 'accept-invitation') {
                const [invite] = await sql<
                  {
                    id: string
                    email: string
                    role: string
                    status: string
                    expires_at: string
                    inviter_id: string
                  }[]
                >`select * from invitation where id=${body.invitationId} and organization_id=${workspaceId}`
                if (invite?.status !== 'pending' || new Date(invite.expires_at) <= new Date())
                  deny('INVITATION_INVALID', 'Invitation expired or unavailable')
                const [recipient] = await sql<
                  { email: string; email_verified: boolean }[]
                >`select email,email_verified from "user" where id=${user.id}`
                if (invite.email.toLowerCase() !== recipient?.email.toLowerCase())
                  deny('INVITATION_RECIPIENT', 'Invitation belongs to another email')
                if (!recipient?.email_verified)
                  deny(
                    'INVITATION_EMAIL_UNVERIFIED',
                    'Verify your email before accepting an invitation',
                  )
                if (actor) deny('ALREADY_MEMBER', 'Already a member')
                if (invite.role === 'owner') {
                  const [inviter] =
                    await sql`select id from member where organization_id=${workspaceId} and user_id=${invite.inviter_id} and role='owner'`
                  if (!inviter) deny('WORKSPACE_PERMISSION', 'Inviter is no longer an owner')
                  await checkOwned(user.id)
                }
                await checkSeats()
                const [member] =
                  await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspaceId},${user.id},${parse(roles, invite.role)}) returning id,organization_id as "organizationId",user_id as "userId",role,created_at as "createdAt"`
                const [invitation] =
                  await sql`update invitation set status='accepted',updated_at=now() where id=${invite.id} returning id,organization_id as "organizationId",email,role,status,expires_at as "expiresAt"`
                await auditMember(sql, workspaceId, 'workspace.member_added', String(member?.id), {
                  targetUserId: user.id,
                  oldRole: null,
                  newRole: invite.role,
                  invitationId: invite.id,
                })
                return { member, invitation }
              }
              if (action === 'transfer-owner') {
                if (actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can transfer ownership')
                const input = parse(transferInput, body)
                const [target] = await sql<
                  { id: string; user_id: string }[]
                >`select m.id,m.user_id from member m join "user" u on u.id=m.user_id where m.id=${input.memberId} and m.organization_id=${workspaceId} and not (coalesce(u.banned,false) and (u.ban_expires is null or u.ban_expires>now()))`
                if (!target || target.id === actor.id)
                  deny('INVALID_TRANSFER', 'Choose another member')
                if (target.user_id !== targetUserId) missing()
                const [currentTarget] = await sql`select role from member where id=${target.id}`
                if (currentTarget?.role !== 'owner') await checkOwned(target.user_id)
                await sql`update member set role='owner',updated_at=now() where id=${target.id}`
                await sql`update member set role='admin',updated_at=now() where id=${actor.id}`
                await auditMember(sql, workspaceId, 'workspace.member_role_changed', target.id, {
                  targetUserId: target.user_id,
                  oldRole: currentTarget?.role,
                  newRole: 'owner',
                })
                await auditMember(sql, workspaceId, 'workspace.member_role_changed', actor.id, {
                  targetUserId: user.id,
                  oldRole: actor.role,
                  newRole: 'admin',
                })
                return { status: true }
              }
              if (action !== 'leave' && actor?.role !== 'owner' && actor?.role !== 'admin')
                deny('WORKSPACE_PERMISSION', 'Member management requires admin or owner')
              if (action === 'add-member') {
                const input = parse(addInput, body)
                if (input.role === 'owner' && actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can grant ownership')
                const [target] =
                  await sql`select id from "user" where id=${input.userId} and not coalesce(banned,false)`
                if (!target) deny('INVALID_MEMBER', 'User unavailable')
                if (
                  (
                    await sql`select id from member where organization_id=${workspaceId} and user_id=${input.userId}`
                  ).length
                )
                  deny('ALREADY_MEMBER', 'Already a member')
                if (input.role === 'owner') await checkOwned(input.userId)
                await checkSeats()
                const [member] =
                  await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspaceId},${input.userId},${input.role}) returning id,organization_id as "organizationId",user_id as "userId",role,created_at as "createdAt"`
                await auditMember(sql, workspaceId, 'workspace.member_added', String(member?.id), {
                  targetUserId: input.userId,
                  oldRole: null,
                  newRole: input.role,
                })
                return { member }
              }
              if (action === 'invite-member') {
                const input = parse(
                  z.object({ email: z.email(), role: roles.default('member') }),
                  body,
                )
                if (input.role === 'owner' && actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can grant ownership')
                await checkSeats()
                const [existing] =
                  await sql`select m.id from member m join "user" u on u.id=m.user_id where m.organization_id=${workspaceId} and lower(u.email)=lower(${input.email})`
                if (existing) deny('ALREADY_MEMBER', 'Already a member')
                const [pending] =
                  await sql`select id from invitation where organization_id=${workspaceId} and lower(email)=lower(${input.email}) and status='pending' and expires_at>now()`
                if (pending) deny('INVITATION_EXISTS', 'A pending invitation already exists')
                const [invitation] =
                  await sql`insert into invitation (id,organization_id,email,role,inviter_id,expires_at) values (${newId()},${workspaceId},${input.email.toLowerCase()},${input.role},${user.id},${(new Date(Date.now() + 7 * 86400000)).toISOString()}) returning id,organization_id as "organizationId",email,role,status,inviter_id as "inviterId",expires_at as "expiresAt"`
                await auditMember(
                  sql,
                  workspaceId,
                  'workspace.member_invited',
                  String(invitation?.id),
                  { email: input.email, newRole: input.role },
                )
                return { invitation, workspace }
              }
              if (action === 'cancel-invitation') {
                const [pending] =
                  await sql`select role from invitation where id=${body.invitationId} and organization_id=${workspaceId}`
                if (pending?.role === 'owner' && actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can manage ownership')
                const [invitation] =
                  await sql`update invitation set status='canceled',updated_at=now() where id=${body.invitationId} and organization_id=${workspaceId} and status='pending' returning id,organization_id as "organizationId",email,role,status,expires_at as "expiresAt"`
                if (!invitation) deny('INVITATION_INVALID', 'Invitation unavailable')
                await auditMember(
                  sql,
                  workspaceId,
                  'workspace.invitation_canceled',
                  String(invitation?.id),
                  { oldRole: pending?.role },
                )
                return { invitation }
              }
              if (
                action === 'remove-member' ||
                action === 'update-member-role' ||
                action === 'leave'
              ) {
                const targetId =
                  action === 'leave' ? actor?.id : (body.memberId ?? body.memberIdOrEmail)
                const [target] = await sql<
                  { id: string; role: string; user_id: string }[]
                >`select m.id,m.role,m.user_id from member m join "user" u on u.id=m.user_id where m.organization_id=${workspaceId} and (m.id::text=${targetId ?? ''} or lower(u.email)=lower(${targetId ?? ''}))`
                if (!target) missing()
                const newRole = action === 'update-member-role' ? parse(roles, body.role) : null
                if (
                  action !== 'leave' &&
                  actor?.role !== 'owner' &&
                  (target.role === 'owner' || newRole === 'owner')
                )
                  deny('WORKSPACE_PERMISSION', 'Only owners can manage ownership')
                if (target.role === 'owner' && newRole !== 'owner') {
                  const [owners] = await sql<
                    { total: number }[]
                  >`select count(*)::int as total from member where organization_id=${workspaceId} and role='owner'`
                  if ((owners?.total ?? 0) <= 1)
                    deny('LAST_OWNER', 'The last owner cannot leave or be demoted')
                }
                if (action !== 'leave' && target.user_id !== targetUserId) missing()
                if (newRole === 'owner' && target.role !== 'owner') await checkOwned(target.user_id)
                if (newRole) {
                  const [member] =
                    await sql`update member set role=${newRole},updated_at=now() where id=${target.id} returning id,organization_id as "organizationId",user_id as "userId",role`
                  await auditMember(sql, workspaceId, 'workspace.member_role_changed', target.id, {
                    targetUserId: target.user_id,
                    oldRole: target.role,
                    newRole,
                  })
                  return { member }
                }
                await sql`delete from member where id=${target.id}`
                await auditMember(sql, workspaceId, 'workspace.member_removed', target.id, {
                  targetUserId: target.user_id,
                  oldRole: target.role,
                  newRole: null,
                })
                return { member: target }
              }
              if (action === 'update') {
                if (actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can update workspace settings')
                const data = parse(
                  z
                    .object({
                      name: z.string().trim().min(1).max(100).optional(),
                      slug: z.string().optional(),
                      logo: z.string().nullable().optional(),
                      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
                    })
                    .strict(),
                  body.data,
                )
                if (data.slug !== undefined) {
                  validSlug(data.slug)
                  await sql`select pg_advisory_xact_lock(hashtextextended(${`slug:${data.slug}`}, 0))`
                  if (
                    (
                      await sql`select id from organization where slug=${data.slug} and id<>${workspaceId}`
                    ).length
                  )
                    throw APIError.from('BAD_REQUEST', {
                      code: 'SLUG_TAKEN',
                      message: 'Slug already in use',
                    })
                }
                const changes: Record<string, string | null> = {
                  updated_at: new Date().toISOString(),
                }
                if (data.name !== undefined) changes.name = data.name
                if (data.slug !== undefined) changes.slug = data.slug
                if (data.logo !== undefined) changes.logo = data.logo
                if (data.metadata !== undefined)
                  changes.metadata = data.metadata === null ? null : JSON.stringify(data.metadata)
                const [org] =
                  await sql`update organization set ${sql(changes)} where id=${workspaceId} returning id,name,slug,logo,metadata,is_personal as "isPersonal",deleted_at as "deletedAt",created_at as "createdAt",updated_at as "updatedAt"`
                return { ...org, metadata: org?.metadata ? JSON.parse(org.metadata) : null }
              }
              if (!mutations.has(action))
                deny('WORKSPACE_OPERATION_DISABLED', 'Unsupported workspace mutation')
              return null
            })
            if (action === 'set-active') {
              await ctx.context.options.secondaryStorage?.delete(session.token)
              await setSessionCookie(ctx, {
                session: { ...session, activeOrganizationId: workspaceId },
                user,
              })
            }
            if (result && 'workspace' in result && 'invitation' in result) {
              const invitation = result.invitation as { id: string; email: string; role: string }
              await sendEmail({
                type: 'invitation',
                to: invitation.email,
                invitationId: invitation.id,
                workspaceName: result.workspace.name,
                inviterName: user.name,
                role: invitation.role,
              })
              return ctx.json(invitation)
            }
            if (result) return ctx.json(result)
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
