import type { TemplateConfig } from '@product-res/config'
import type { Database } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import { z } from 'zod'
import type { ResolveMaxSeats } from './team-workspaces.ts'

/**
 * 团队空间邀请链接（openspec/changes/add-team-invite-links D2–D8）。
 *
 * 与 team-workspaces.ts 共用锁协议：先 `owner:<用户>` 再 `ws:<空间>` 的事务级 advisory lock，
 * 席位校验与邮件邀请、直接加成员持有同一把 `ws:` 锁，三条入口之间不会超卖。
 * token 只在生成时返回一次，库中只存 SHA-256 哈希；日志与审计只记链接 ID。
 */

export const INVITE_LINK_TTL_DAYS = [1, 7, 30] as const
export const INVITE_LINK_DEFAULT_TTL_DAYS = 7
export const INVITE_LINK_MAX_USES_LIMIT = 1000
export type InviteLinkRole = 'member' | 'admin'
export type InviteLinkStatus = 'active' | 'revoked' | 'expired' | 'exhausted' | 'inactive'

/** 32 字节随机值的 base64url（无填充）恰为 43 个字符 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export function isInviteLinkToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

export interface InviteLinkDeps {
  readonly db: Database
  readonly config: Pick<TemplateConfig, 'tenancy'>
  /** 只在调用方给出的事务内读本地权益（web 的 resolveWorkspaceMaxSeats） */
  readonly resolveMaxSeats?: ResolveMaxSeats
}

/** 已通过真实会话校验的操作者；锁内按 sessionId 再复核一次，防止校验后会话被吊销 */
export interface InviteLinkActor {
  readonly userId: string
  readonly sessionId: string
  readonly clientIp?: string | null
}

export interface InviteLinkSummary {
  readonly id: string
  readonly role: InviteLinkRole
  readonly status: InviteLinkStatus
  readonly expiresAt: string
  readonly maxUses: number | null
  readonly usedCount: number
  readonly revokedAt: string | null
  readonly createdAt: string
  readonly createdBy: { readonly id: string; readonly name: string }
}

export interface InviteLinkWorkspace {
  readonly id: string
  readonly name: string
  readonly slug: string
}

export type InviteLinkPreview =
  | {
      readonly status: 'valid'
      readonly workspace: InviteLinkWorkspace
      readonly role: InviteLinkRole
    }
  | { readonly status: 'member'; readonly workspace: InviteLinkWorkspace }
  | {
      readonly status: 'invalid' | 'disabled' | 'seats_full' | Exclude<InviteLinkStatus, 'active'>
    }

const createInput = z.object({
  workspaceId: z.uuid(),
  role: z.enum(['member', 'admin']),
  ttlDays: z.union(INVITE_LINK_TTL_DAYS.map((days) => z.literal(days))),
  maxUses: z.number().int().min(1).max(INVITE_LINK_MAX_USES_LIMIT).nullable(),
})
export type CreateInviteLinkInput = z.input<typeof createInput>
const revokeInput = z.object({ workspaceId: z.uuid(), linkId: z.uuid() })

type Sql = Database['$client']

function fail(code: string, message: string, status: number): never {
  throw new AppError(code, message, { status })
}
function missing(): never {
  return fail('WORKSPACE_NOT_FOUND', 'Workspace not found', 404)
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) fail('INVALID_INPUT', 'Invalid input', 400)
  return result.data
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function generateInviteLinkToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashInviteLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 常量时间比较：耗时只取决于长度（哈希定长），与内容无关 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  return diff === 0
}

interface LinkRow {
  id: string
  workspace_id: string
  token_hash: string
  role: InviteLinkRole
  expires_at: Date
  max_uses: number | null
  used_count: number
  revoked_at: Date | null
  created_by: string
  created_at: Date
}

/** 状态优先级：作废 > 过期 > 用完 > 创建人已失去管理权限 > 有效 */
export function inviteLinkStatus(
  link: Pick<LinkRow, 'expires_at' | 'max_uses' | 'used_count' | 'revoked_at'>,
  creatorCanManage: boolean,
  now = new Date(),
): InviteLinkStatus {
  if (link.revoked_at) return 'revoked'
  if (new Date(link.expires_at) <= now) return 'expired'
  if (link.max_uses !== null && link.used_count >= link.max_uses) return 'exhausted'
  if (!creatorCanManage) return 'inactive'
  return 'active'
}

const statusErrors: Record<Exclude<InviteLinkStatus, 'active'>, [string, string]> = {
  revoked: ['INVITE_LINK_REVOKED', 'Invite link has been revoked'],
  expired: ['INVITE_LINK_EXPIRED', 'Invite link has expired'],
  exhausted: ['INVITE_LINK_EXHAUSTED', 'Invite link has reached its usage limit'],
  inactive: ['INVITE_LINK_INACTIVE', 'Invite link is no longer valid'],
}

async function lock(sql: Sql, key: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

async function checkFresh(sql: Sql, actor: InviteLinkActor) {
  const rows = await sql`select s.id from session s join "user" u on u.id=s.user_id
    where s.id=${actor.sessionId} and s.user_id=${actor.userId} and s.expires_at>now()
    and not (coalesce(u.banned,false) and (u.ban_expires is null or u.ban_expires>now()))`
  if (!rows.length) fail('SESSION_REQUIRED', 'Sign in required', 401)
}

async function audit(
  sql: Sql,
  actor: InviteLinkActor,
  workspaceId: string,
  action: string,
  targetType: string,
  targetId: string,
  meta: Record<string, unknown>,
) {
  await sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,ip,meta)
    values (${newId()},${actor.userId},${workspaceId},${action},${targetType},${targetId},
      ${actor.clientIp ?? null},${JSON.stringify(meta)}::jsonb)`
}

interface WorkspaceRow {
  id: string
  name: string
  slug: string
  is_personal: boolean
  deleted_at: Date | null
}

async function workspaceRow(sql: Sql, id: string): Promise<WorkspaceRow | undefined> {
  const [row] = await sql<
    WorkspaceRow[]
  >`select id,name,slug,is_personal,deleted_at from organization where id=${id}`
  return row
}

async function memberRole(sql: Sql, workspaceId: string, userId: string) {
  const [row] = await sql<
    { id: string; role: string }[]
  >`select id,role from member where organization_id=${workspaceId} and user_id=${userId}`
  return row
}

const canManage = (role: string | undefined) => role === 'owner' || role === 'admin'

/** 生成 / 作废 / 列表共用的准入：空间存在、团队空间、开关开启、操作者为 owner / admin */
async function requireManager(
  sql: Sql,
  deps: InviteLinkDeps,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRow> {
  const workspace = await workspaceRow(sql, workspaceId)
  if (!workspace || workspace.deleted_at) missing()
  const actor = await memberRole(sql, workspaceId, userId)
  // 非成员与不存在不可区分
  if (!actor) missing()
  if (workspace.is_personal)
    fail('PERSONAL_WORKSPACE', 'Personal workspace membership cannot change', 403)
  if (!deps.config.tenancy.multiTenant)
    fail('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', 403)
  if (!canManage(actor.role))
    fail('WORKSPACE_PERMISSION', 'Member management requires admin or owner', 403)
  return workspace
}

function summary(
  row: LinkRow & { creator_name: string; creator_role: string | null },
  now: Date,
): InviteLinkSummary {
  return {
    id: row.id,
    role: row.role,
    status: inviteLinkStatus(row, canManage(row.creator_role ?? undefined), now),
    expiresAt: new Date(row.expires_at).toISOString(),
    maxUses: row.max_uses,
    usedCount: row.used_count,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { id: row.created_by, name: row.creator_name },
  }
}

async function selectSummaries(sql: Sql, workspaceId: string, linkId?: string) {
  const rows = await sql<(LinkRow & { creator_name: string; creator_role: string | null })[]>`
    select l.*, u.name as creator_name, m.role as creator_role
    from workspace_invite_link l
    join "user" u on u.id=l.created_by
    left join member m on m.organization_id=l.workspace_id and m.user_id=l.created_by
    where l.workspace_id=${workspaceId} ${linkId ? sql`and l.id=${linkId}` : sql``}
    order by l.id desc limit 100`
  const now = new Date()
  return rows.map((row) => summary(row, now))
}

export async function createInviteLink(
  deps: InviteLinkDeps,
  actor: InviteLinkActor,
  input: CreateInviteLinkInput,
): Promise<{ readonly link: InviteLinkSummary; readonly token: string }> {
  const data = parse(createInput, input)
  const token = generateInviteLinkToken()
  const tokenHash = await hashInviteLinkToken(token)
  const link = await deps.db.$client.begin(async (tx) => {
    const sql = tx as unknown as Sql
    await lock(sql, `owner:${actor.userId}`)
    await lock(sql, `ws:${data.workspaceId}`)
    await checkFresh(sql, actor)
    await requireManager(sql, deps, data.workspaceId, actor.userId)
    const id = newId()
    const expiresAt = new Date(Date.now() + data.ttlDays * 86_400_000)
    await sql`insert into workspace_invite_link (id,workspace_id,token_hash,role,expires_at,max_uses,created_by)
      values (${id},${data.workspaceId},${tokenHash},${data.role},${expiresAt.toISOString()},${data.maxUses},${actor.userId})`
    await audit(sql, actor, data.workspaceId, 'workspace.invite_link_created', 'invite_link', id, {
      role: data.role,
      expiresAt: expiresAt.toISOString(),
      maxUses: data.maxUses,
    })
    const [created] = await selectSummaries(sql, data.workspaceId, id)
    if (!created) throw new Error('Invite link insert returned no row')
    return created
  })
  return { link, token }
}

export async function listInviteLinks(
  deps: InviteLinkDeps,
  userId: string,
  workspaceId: string,
): Promise<InviteLinkSummary[]> {
  const sql = deps.db.$client as unknown as Sql
  await requireManager(sql, deps, parse(z.uuid(), workspaceId), userId)
  return selectSummaries(sql, workspaceId)
}

export async function revokeInviteLink(
  deps: InviteLinkDeps,
  actor: InviteLinkActor,
  input: z.input<typeof revokeInput>,
): Promise<InviteLinkSummary> {
  const data = parse(revokeInput, input)
  return deps.db.$client.begin(async (tx) => {
    const sql = tx as unknown as Sql
    await lock(sql, `owner:${actor.userId}`)
    await lock(sql, `ws:${data.workspaceId}`)
    await checkFresh(sql, actor)
    await requireManager(sql, deps, data.workspaceId, actor.userId)
    const [revoked] = await sql<{ id: string; role: string }[]>`update workspace_invite_link
      set revoked_at=now(),revoked_by=${actor.userId},updated_at=now()
      where id=${data.linkId} and workspace_id=${data.workspaceId} and revoked_at is null
      returning id,role`
    if (!revoked) {
      const [existing] = await sql`select id from workspace_invite_link
        where id=${data.linkId} and workspace_id=${data.workspaceId}`
      if (!existing) fail('INVITE_LINK_INVALID', 'Invite link not found', 404)
    } else {
      await audit(
        sql,
        actor,
        data.workspaceId,
        'workspace.invite_link_revoked',
        'invite_link',
        revoked.id,
        {
          role: revoked.role,
        },
      )
    }
    const [link] = await selectSummaries(sql, data.workspaceId, data.linkId)
    if (!link) fail('INVITE_LINK_INVALID', 'Invite link not found', 404)
    return link
  })
}

/** 按 token 找链接：先按哈希走唯一索引，再常量时间复核 */
async function findByToken(sql: Sql, token: string): Promise<LinkRow | undefined> {
  if (!isInviteLinkToken(token)) return undefined
  const tokenHash = await hashInviteLinkToken(token)
  const [row] = await sql<
    LinkRow[]
  >`select * from workspace_invite_link where token_hash=${tokenHash}`
  return row && constantTimeEqual(row.token_hash, tokenHash) ? row : undefined
}

const publicWorkspace = (w: WorkspaceRow): InviteLinkWorkspace => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
})

async function seatsFull(sql: Sql, deps: InviteLinkDeps, workspaceId: string) {
  const limit = deps.resolveMaxSeats ? await deps.resolveMaxSeats(workspaceId, sql) : null
  if (limit === null) return false
  const [count] = await sql<
    { total: number }[]
  >`select count(*)::int as total from member where organization_id=${workspaceId}`
  return (count?.total ?? 0) >= limit
}

/** `/join/<token>` 的展示状态；只给已登录用户调用（未登录时页面不查询链接，不泄露空间名） */
export async function previewInviteLink(
  deps: InviteLinkDeps,
  userId: string,
  token: string,
): Promise<InviteLinkPreview> {
  const sql = deps.db.$client as unknown as Sql
  const link = await findByToken(sql, token)
  if (!link) return { status: 'invalid' }
  const workspace = await workspaceRow(sql, link.workspace_id)
  if (!workspace || workspace.deleted_at || workspace.is_personal) return { status: 'invalid' }
  if (await memberRole(sql, workspace.id, userId))
    return { status: 'member', workspace: publicWorkspace(workspace) }
  if (!deps.config.tenancy.multiTenant) return { status: 'disabled' }
  const creator = await memberRole(sql, workspace.id, link.created_by)
  const status = inviteLinkStatus(link, canManage(creator?.role))
  if (status !== 'active') return { status }
  if (await seatsFull(sql, deps, workspace.id)) return { status: 'seats_full' }
  return { status: 'valid', workspace: publicWorkspace(workspace), role: link.role }
}

/**
 * 通过链接加入。已是成员时不消耗次数，直接返回该空间；其余失败抛出带错误码的 AppError：
 * INVITE_LINK_INVALID / _REVOKED / _EXPIRED / _EXHAUSTED / _INACTIVE、SEATS_FULL、WORKSPACE_READ_ONLY。
 */
export async function joinWithInviteLink(
  deps: InviteLinkDeps,
  actor: InviteLinkActor,
  token: string,
): Promise<{
  readonly workspace: InviteLinkWorkspace
  readonly role: string
  readonly alreadyMember: boolean
}> {
  // 锁键需要空间 ID：锁外的查找只用于选锁，锁内重新读取并复核
  const found = await findByToken(deps.db.$client as unknown as Sql, token)
  if (!found) fail('INVITE_LINK_INVALID', 'Invite link not found', 404)
  return deps.db.$client.begin(async (tx) => {
    const sql = tx as unknown as Sql
    await lock(sql, `owner:${actor.userId}`)
    await lock(sql, `ws:${found.workspace_id}`)
    await checkFresh(sql, actor)
    const [link] = await sql<LinkRow[]>`select * from workspace_invite_link
      where id=${found.id} for update`
    if (!link) fail('INVITE_LINK_INVALID', 'Invite link not found', 404)
    const workspace = await workspaceRow(sql, link.workspace_id)
    if (!workspace || workspace.deleted_at || workspace.is_personal)
      fail('INVITE_LINK_INVALID', 'Invite link not found', 404)
    const existing = await memberRole(sql, workspace.id, actor.userId)
    if (existing)
      return { workspace: publicWorkspace(workspace), role: existing.role, alreadyMember: true }
    if (!deps.config.tenancy.multiTenant)
      fail('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', 403)
    const creator = await memberRole(sql, workspace.id, link.created_by)
    const status = inviteLinkStatus(link, canManage(creator?.role))
    if (status !== 'active') fail(...statusErrors[status], 410)
    if (await seatsFull(sql, deps, workspace.id))
      fail('SEATS_FULL', 'Workspace seats are full', 403)
    const memberId = newId()
    await sql`insert into member (id,organization_id,user_id,role)
      values (${memberId},${workspace.id},${actor.userId},${link.role})`
    await sql`update workspace_invite_link set used_count=used_count+1,updated_at=now()
      where id=${link.id}`
    await audit(sql, actor, workspace.id, 'workspace.member_added', 'member', memberId, {
      targetUserId: actor.userId,
      oldRole: null,
      newRole: link.role,
      inviteLinkId: link.id,
    })
    return { workspace: publicWorkspace(workspace), role: link.role, alreadyMember: false }
  })
}
