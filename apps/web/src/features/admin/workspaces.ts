import type { TemplateConfig } from '@product-res/config'
import { getCreditBalance, getCreditBatches, getCreditLedger } from '@product-res/credits'
import {
  type Database,
  member,
  organization,
  plan,
  scoped,
  subscription,
  user,
} from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import { AppError } from '@product-res/shared'
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { templateConfig } from '../../server/template-config.ts'
import { ADMIN_PAGE_SIZE, adminListSearch } from './list.ts'

export async function listAdminWorkspaces(
  db: Database,
  input: { offset?: number; q?: string | undefined; status?: string | undefined },
) {
  const { offset, q, status } = adminListSearch(['q', 'status'])(input)
  const rows = await db
    .select()
    .from(organization)
    .where(
      and(
        q
          ? or(
              ilike(organization.name, `%${q}%`),
              ilike(organization.slug, `%${q}%`),
              ilike(sql`${organization.id}::text`, `%${q}%`),
            )
          : undefined,
        status === 'deleted'
          ? isNotNull(organization.deletedAt)
          : status === 'active'
            ? isNull(organization.deletedAt)
            : undefined,
      ),
    )
    .orderBy(desc(organization.createdAt), desc(organization.id))
    .offset(offset)
    .limit(ADMIN_PAGE_SIZE + 1)
  return { rows: rows.slice(0, ADMIN_PAGE_SIZE), hasMore: rows.length > ADMIN_PAGE_SIZE }
}

export async function adminWorkspaceDetail(
  db: Database,
  id: string,
  pastDueGraceDays: number,
  config: TemplateConfig = templateConfig,
) {
  const [workspace] = await db.select().from(organization).where(eq(organization.id, id))
  if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found', { status: 404 })
  const members = await scoped(db, id)
    .select(member, {
      fields: {
        id: member.id,
        role: member.role,
        userId: user.id,
        name: user.name,
        email: user.email,
      },
    })
    .innerJoin(user, eq(member.userId, user.id))
  const subscriptions = config.billing.enabled
    ? await scoped(db, id)
        .select(subscription, { fields: { subscription, planName: plan.name } })
        .innerJoin(plan, eq(subscription.planId, plan.id))
        .orderBy(desc(subscription.currentPeriodEnd), desc(subscription.id))
    : []
  const [balance, batches, ledger, entitlements] = await Promise.all([
    config.credits.enabled ? getCreditBalance(db, id) : null,
    config.credits.enabled ? getCreditBatches(db, id) : { items: [], nextCursor: null },
    config.credits.enabled ? getCreditLedger(db, id) : { items: [], nextCursor: null },
    config.billing.enabled ? getEntitlements(db, id, { pastDueGraceDays }) : null,
  ])
  return { workspace, members, subscriptions, balance, batches, ledger, entitlements }
}
