import type { ResolveMaxSeats } from '@product-res/auth'
import { type Database, invitation, member, scoped, user } from '@product-res/db'
import {
  type EntitlementSubscription,
  type Entitlements,
  selectEntitlements,
} from '@product-res/entitlements'
import { eq } from 'drizzle-orm'
import { templateConfig } from './template-config.ts'

/** 空间当前生效的套餐与席位上限；未开启计费时都为 null。 */
export interface WorkspacePlan {
  planKey: string | null
  maxSeats: number | null
}

/** Reads through the caller's transaction, preserving the auth workspace lock. */
export async function resolveWorkspacePlan(
  workspaceId: string,
  sql: Parameters<ResolveMaxSeats>[1],
): Promise<WorkspacePlan> {
  if (!templateConfig.billing.enabled) return { planKey: null, maxSeats: null }
  const now = new Date()
  const subscriptions = await sql.unsafe<EntitlementSubscription[]>(
    `select s.status, s.past_due_since as "pastDueSince", s.current_period_end as "currentPeriodEnd",
      jsonb_build_object('key', p.key, 'sort', p.sort, 'features', p.features) as plan
     from subscription s join plan p on p.id = s.plan_id where s.workspace_id = $1`,
    [workspaceId],
  )
  const [free] = await sql.unsafe<Entitlements[]>(
    `select key, sort, features from plan where key = 'free'`,
  )
  const entitlements = selectEntitlements(subscriptions, free, {
    now,
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
  })
  return { planKey: entitlements.key, maxSeats: entitlements.features.maxSeats }
}

/** Reads through the caller's transaction, preserving the auth workspace lock. */
export const resolveWorkspaceMaxSeats: ResolveMaxSeats = async (workspaceId, sql) =>
  (await resolveWorkspacePlan(workspaceId, sql)).maxSeats

export async function workspaceMembers(db: Database, workspaceId: string) {
  return scoped(db, workspaceId)
    .select(member, {
      fields: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        name: user.name,
        email: user.email,
      },
    })
    .innerJoin(user, eq(member.userId, user.id))
}

export async function workspaceInvitations(db: Database, workspaceId: string) {
  return scoped(db, workspaceId).select(invitation)
}

export async function userWorkspaces(db: Database, userId: string) {
  const memberships = await db.query.member.findMany({ where: (m, { eq }) => eq(m.userId, userId) })
  const spaces = await Promise.all(
    memberships.map((m) =>
      db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, m.organizationId) }),
    ),
  )
  return spaces.flatMap((o) =>
    o && !o.deletedAt ? [{ id: o.id, name: o.name, slug: o.slug, isPersonal: o.isPersonal }] : [],
  )
}
export async function recipientInvitation(
  db: Database,
  id: string,
  email: string,
  emailVerified: boolean,
) {
  const invite = await db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.id, id) })
  if (!invite) return { error: 'INVITATION_INVALID' } as const
  if (invite.email.toLowerCase() !== email.toLowerCase())
    return { error: 'INVITATION_RECIPIENT' } as const
  if (invite.status !== 'pending' || invite.expiresAt <= new Date())
    return { error: 'INVITATION_INVALID' } as const
  if (!emailVerified) return { verifyRequired: true, email, id: invite.id } as const
  const workspace = await db.query.organization.findFirst({
    where: (o, { eq }) => eq(o.id, invite.organizationId),
  })
  if (!workspace || workspace.deletedAt) return { error: 'INVITATION_INVALID' } as const
  return {
    invitation: { id: invite.id, role: invite.role },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
  } as const
}
