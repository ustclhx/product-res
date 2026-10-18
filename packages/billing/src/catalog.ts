import { type Database, type Plan, type PlanPrice, plan, planPrice } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PaymentProvider } from './provider.ts'

/** Template examples in USD cents, not approved business prices. Model permissions are managed in the admin console. */
export const EXAMPLE_CATALOG = [
  {
    key: 'free',
    name: 'Free',
    type: 'subscription',
    credits: 0,
    creditExpiryDays: null,
    rollover: false,
    features: DEFAULT_FREE_FEATURES,
    sort: 0,
    active: true,
    prices: [],
  },
  {
    key: 'pro',
    name: 'Pro (template example)',
    type: 'subscription',
    credits: 1000,
    creditExpiryDays: null,
    rollover: false,
    features: {
      ...DEFAULT_FREE_FEATURES,
      models: [],
      maxConcurrentTasks: 10,
      storageGb: 50,
      watermark: false,
    },
    sort: 10,
    active: true,
    prices: [
      { interval: 'month', amount: 1900 },
      { interval: 'year', amount: 19000 },
    ],
  },
  {
    key: 'team',
    name: 'Team (template example)',
    type: 'subscription',
    credits: 5000,
    creditExpiryDays: null,
    rollover: false,
    features: {
      ...DEFAULT_FREE_FEATURES,
      models: [],
      maxConcurrentTasks: 30,
      maxSeats: 10,
      storageGb: 200,
      publicApi: true,
      priorityQueue: true,
      watermark: false,
    },
    sort: 20,
    active: true,
    prices: [
      { interval: 'month', amount: 4900 },
      { interval: 'year', amount: 49000 },
    ],
  },
  {
    key: 'credit_pack',
    name: 'Credit pack (template example)',
    type: 'credit_pack',
    credits: 1000,
    creditExpiryDays: 365,
    rollover: false,
    features: DEFAULT_FREE_FEATURES,
    sort: 0,
    active: true,
    prices: [{ interval: null, amount: 1000 }],
  },
] satisfies (Omit<typeof plan.$inferInsert, 'id'> & {
  prices: { interval: PlanPrice['interval']; amount: number }[]
})[]

const PROVIDERS = ['stripe', 'paypal'] as const
function tuple(
  planId: string,
  provider: PlanPrice['provider'],
  interval: PlanPrice['interval'],
  amount: number,
) {
  return and(
    eq(planPrice.planId, planId),
    eq(planPrice.provider, provider),
    interval === null ? isNull(planPrice.interval) : eq(planPrice.interval, interval),
    eq(planPrice.amount, amount),
    eq(planPrice.currency, 'USD'),
  )
}

/** Database only: no provider construction, credentials, or network access. */
export async function seedCatalog(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const { prices, ...values } of EXAMPLE_CATALOG) {
      const [localPlan] = await tx
        .insert(plan)
        .values(values)
        .onConflictDoUpdate({
          target: plan.key,
          set: {
            ...values,
            // 重跑 seed 保留后台授权；在同一个 upsert 内合并，避免覆盖并发编辑。
            features: sql`excluded.features || jsonb_build_object('models', ${plan.features}->'models')`,
          },
        })
        .returning()
      if (!localPlan) throw new Error('Catalog plan upsert returned no row')
      // The upsert locks the plan until commit, serializing tuple creation across seed runs.
      for (const provider of PROVIDERS) {
        for (const price of prices) {
          const existing = await tx
            .select()
            .from(planPrice)
            .where(tuple(localPlan.id, provider, price.interval, price.amount))
          if (existing.length) continue
          const id = newId()
          await tx.insert(planPrice).values({
            id,
            planId: localPlan.id,
            provider,
            providerPriceId: `unsynced:${provider}:${id}`,
            interval: price.interval,
            amount: price.amount,
            currency: 'USD',
            active: false,
          })
        }
      }
    }
  })
}

/** Sync only current example tuples; obsolete immutable prices retain their historical mapping. */
export async function syncCatalog(
  db: Database,
  providers: readonly PaymentProvider[],
): Promise<number> {
  let synced = 0
  for (const provider of providers) {
    for (const example of EXAMPLE_CATALOG) {
      if (!example.prices.length) continue // Free has no remote price or checkout.
      const [localPlan] = await db.select().from(plan).where(eq(plan.key, example.key))
      if (!localPlan) throw new Error(`Seed catalog before syncing ${example.key}`)
      for (const intended of example.prices) {
        const prices = await db
          .select()
          .from(planPrice)
          .where(tuple(localPlan.id, provider.id, intended.interval, intended.amount))
        if (prices.length !== 1)
          throw new Error(`Expected one seeded price for ${example.key}/${provider.id}`)
        const price = prices[0] as PlanPrice
        const existingId = price.providerPriceId.startsWith('unsynced:')
          ? undefined
          : price.providerPriceId
        // Remote I/O is deliberately outside a database transaction. Desired activation is
        // separate from local readiness: placeholders must remain inactive on failure.
        const remote = await provider.syncPlan({
          plan: localPlan as Plan,
          price: { ...price, active: true },
          ...(existingId ? { providerPriceId: existingId } : {}),
          idempotencyKey: `catalog:${provider.id}:${price.id}`,
        })
        if (!remote.providerPriceId || remote.providerPriceId.startsWith('unsynced:'))
          throw new Error('Provider returned an invalid catalog mapping')
        if (existingId && remote.providerPriceId !== existingId)
          throw new Error('Provider changed an immutable catalog mapping')
        if (price.providerPriceId === remote.providerPriceId && price.active === localPlan.active) {
          synced++
          continue
        }
        const updated = await db
          .update(planPrice)
          .set({ providerPriceId: remote.providerPriceId, active: localPlan.active })
          .where(
            and(eq(planPrice.id, price.id), eq(planPrice.providerPriceId, price.providerPriceId)),
          )
          .returning()
        if (!updated.length) {
          const [current] = await db.select().from(planPrice).where(eq(planPrice.id, price.id))
          if (current?.providerPriceId !== remote.providerPriceId)
            throw new Error('Concurrent catalog mapping changed')
        }
        synced++
      }
    }
  }
  return synced
}
