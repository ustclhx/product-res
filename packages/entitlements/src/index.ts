import { type Database, plan, scoped, subscription } from '@product-res/db'
import { eq } from 'drizzle-orm'
import { type EntitlementOptions, selectEntitlements } from './selection.ts'

export * from './selection.ts'

type EntitlementDatabase = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/** Local, workspace-scoped reads only. The caller may retain the result within a request. */
export async function getEntitlements(
  db: EntitlementDatabase,
  workspaceId: string,
  options: EntitlementOptions = {},
) {
  const now = options.now ?? new Date()
  const subscriptions = await scoped(db, workspaceId)
    .select(subscription, {
      fields: {
        status: subscription.status,
        pastDueSince: subscription.pastDueSince,
        currentPeriodEnd: subscription.currentPeriodEnd,
        plan: { key: plan.key, sort: plan.sort, features: plan.features },
      },
    })
    .innerJoin(plan, eq(subscription.planId, plan.id))
  const free = await db.query.plan.findFirst({ where: (p, { eq }) => eq(p.key, 'free') })
  return selectEntitlements(subscriptions, free, { ...options, now })
}
