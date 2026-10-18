import { templateConfigDefaults } from '@product-res/config'
import type { Database } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import { type AuthContextSource, requireFreshSession } from './fresh-session.ts'

export const WORKSPACE_RETENTION_DAYS = 30
const deletionMeta = z.object({ originalOwnerUserIds: z.array(z.uuid()) })
type Transaction = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
function refuse(code: string, message: string, status = 403): never {
  throw new AppError(code, message, { status })
}
async function latestDeletion(sql: Database['$client'] | Transaction, workspaceId: string) {
  const [event] = await sql<{ id: string; meta: unknown }[]>`
    select id,meta from audit_log where workspace_id=${workspaceId} and action='workspace.deleted'
    order by created_at desc,id desc limit 1`
  return event
}
async function alreadyCleaned(sql: Transaction, workspaceId: string, deletionId: string) {
  const [event] = await sql`select id from audit_log where workspace_id=${workspaceId}
    and action='workspace.cleanup.completed' and meta->>'deletionAuditId'=${deletionId} limit 1`
  return Boolean(event)
}

/** Restore only valid original owners; invitations, API keys and old sessions stay revoked. */
export async function restoreWorkspace(options: {
  readonly auth: AuthContextSource
  readonly db: Database
  readonly headers: Headers
  readonly workspaceId: string
  readonly maxWorkspacesPerUser?: number
  readonly clientIp?: string | null | undefined
}) {
  const fresh = await requireFreshSession(options)
  if (fresh.user.role !== 'admin') refuse('ADMIN_REQUIRED', 'Platform administrator required')
  const workspaceId = z.uuid().parse(options.workspaceId)
  const deletion = await latestDeletion(options.db.$client, workspaceId)
  if (!deletion) refuse('WORKSPACE_NOT_FOUND', 'Deleted workspace not found', 404)
  const owners = [...new Set(deletionMeta.parse(deletion.meta).originalOwnerUserIds)].sort()
  return options.db.$client.begin(async (sql) => {
    for (const id of owners)
      await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${id}`},0))`
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`
    // Lock the administrator row so revocation/ban cannot commit during restoration.
    const [admin] = await sql`select u.id from session s join "user" u on u.id=s.user_id
      where s.token=${fresh.session.token} and s.expires_at>clock_timestamp() and s.impersonated_by is null
      and u.role='admin' and not (coalesce(u.banned,false) and (u.ban_expires is null or u.ban_expires>clock_timestamp())) for update of u,s`
    if (!admin) refuse('ADMIN_REQUIRED', 'Active platform administrator session required')
    const [workspace] = await sql<{ is_personal: boolean; eligible: boolean }[]>`
      select is_personal,deleted_at>clock_timestamp()-(${WORKSPACE_RETENTION_DAYS} * interval '1 day') as eligible
      from organization where id=${workspaceId} and deleted_at is not null for update`
    if (!workspace) refuse('WORKSPACE_NOT_FOUND', 'Deleted workspace not found', 404)
    const current = await latestDeletion(sql, workspaceId)
    if (current?.id !== deletion.id)
      refuse('WORKSPACE_CHANGED', 'Deletion changed; retry restoration', 409)
    if (!workspace.eligible || (await alreadyCleaned(sql, workspaceId, deletion.id)))
      refuse('WORKSPACE_RETENTION_EXPIRED', 'Workspace retention period has ended', 409)
    const valid: string[] = []
    for (const id of owners) {
      const [owner] = await sql`select id from "user" where id=${id}
        and email<>${`deleted+${id}@invalid`}
        and not (coalesce(banned,false) and (ban_expires is null or ban_expires>clock_timestamp())) for update`
      if (!owner) continue
      if (!workspace.is_personal) {
        const [owned] = await sql<{ total: number }[]>`select count(*)::int as total from member m
          join organization o on o.id=m.organization_id where m.user_id=${id} and m.role='owner'
          and not o.is_personal and o.deleted_at is null`
        if (
          (owned?.total ?? 0) >=
          (options.maxWorkspacesPerUser ?? templateConfigDefaults.tenancy.maxWorkspacesPerUser)
        )
          refuse('WORKSPACE_LIMIT', 'Original owner workspace limit reached', 409)
      }
      valid.push(id)
    }
    if (!valid.length) refuse('WORKSPACE_OWNER_UNAVAILABLE', 'No original owner is available', 409)
    await sql`delete from member where organization_id=${workspaceId}`
    for (const id of valid)
      await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspaceId},${id},'owner')`
    await sql`update organization set deleted_at=null,updated_at=now() where id=${workspaceId}`
    await sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,ip,meta)
      values (${newId()},${fresh.user.id},${workspaceId},'workspace.restored','organization',${workspaceId},${options.clientIp ?? null},${JSON.stringify({ deletionAuditId: deletion.id, ownerUserIds: valid })}::jsonb)`
    return { restored: true, ownerUserIds: valid }
  })
}

/** P1 content cleanup. Keep organization/user and all audit/finance anchors permanently. */
export async function cleanupExpiredWorkspaces(db: Database) {
  const candidates = await db.$client<{ id: string }[]>`select id from organization
    where deleted_at<=now()-(${WORKSPACE_RETENTION_DAYS} * interval '1 day') order by id`
  let cleaned = 0
  for (const workspace of candidates) {
    const completed = await db.$client.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspace.id}`},0))`
      const [expired] = await sql`select id from organization where id=${workspace.id}
        and deleted_at<=now()-(${WORKSPACE_RETENTION_DAYS} * interval '1 day') for update`
      if (!expired) return false
      const deletion = await latestDeletion(sql, workspace.id)
      if (!deletion || (await alreadyCleaned(sql, workspace.id, deletion.id))) return false
      await sql`delete from notification where workspace_id=${workspace.id}`
      await sql`delete from invitation where organization_id=${workspace.id}`
      await sql`insert into audit_log (id,workspace_id,action,target_type,target_id,meta)
        values (${newId()},${workspace.id},'workspace.cleanup.completed','organization',${workspace.id},${JSON.stringify({ deletionAuditId: deletion.id })}::jsonb)`
      return true
    })
    if (completed) cleaned++
  }
  return { cleaned }
}

/** Mount separately in createAuth; all authorization comes from the current database session. */
export function workspaceLifecyclePlugin(
  db: Database,
  maxWorkspacesPerUser = templateConfigDefaults.tenancy.maxWorkspacesPerUser as number,
  clientIp?: string | null,
) {
  return {
    id: 'workspace-lifecycle',
    endpoints: {
      restoreWorkspace: createAuthEndpoint(
        '/admin/restore-workspace',
        {
          method: 'POST',
          body: z.object({ workspaceId: z.uuid() }),
          requireHeaders: true,
        },
        async (ctx) => {
          try {
            return ctx.json(
              await restoreWorkspace({
                db,
                clientIp,
                maxWorkspacesPerUser,
                workspaceId: ctx.body.workspaceId,
                headers: ctx.headers,
                auth: { $context: Promise.resolve(ctx.context) },
              }),
            )
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            throw new APIError(
              error.status === 401
                ? 'UNAUTHORIZED'
                : error.status === 404
                  ? 'NOT_FOUND'
                  : error.status === 409
                    ? 'CONFLICT'
                    : 'FORBIDDEN',
              { code: error.code, message: error.message },
            )
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
