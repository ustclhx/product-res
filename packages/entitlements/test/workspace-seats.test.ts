import { createDb } from '@product-res/db'
import * as schema from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { expect, it } from 'vitest'
import { resolveWorkspaceMaxSeats } from '../../../apps/web/src/server/workspace-data.ts'
import { DEFAULT_FREE_FEATURES, getEntitlements } from '../src/index.ts'

// This integration test lives here because web test files are owned by the coordinator.
const url = process.env.ENTITLEMENTS_TEST_DATABASE_URL
const rollbackFixture = (error: unknown) => {
  if (!(error instanceof Error) || error.message !== 'rollback fixture') throw error
}

it.skipIf(!url)(
  'seat resolver reads uncommitted plans through the supplied auth transaction',
  async () => {
    const db = createDb(url as string)
    const ws = newId()
    const key = newId()
    const planId = newId()
    const priceId = newId()
    // 已提交的 free 席位随部署数据而定（迁移 0022 / seed 可能为 10），事务外应始终看到它
    const committed = (await getEntitlements(db, ws)).features.maxSeats
    try {
      await db.$client
        .begin(async (tx) => {
          await tx`insert into organization (id, name, slug) values (${ws}, 'Entitlements', ${ws})`
          await tx`insert into plan (id, key, name, type, credits, features) values (${newId()}, 'free', 'Free', 'subscription', 0, ${JSON.stringify(DEFAULT_FREE_FEATURES)}::jsonb) on conflict (key) do update set features=excluded.features`
          expect(await resolveWorkspaceMaxSeats(ws, tx)).toBe(DEFAULT_FREE_FEATURES.maxSeats)
          await tx`insert into plan (id, key, name, type, credits, sort, features) values (${planId}, ${key}, 'Pro', 'subscription', 0, 10, ${JSON.stringify({ ...DEFAULT_FREE_FEATURES, maxSeats: 5 })}::jsonb)`
          await tx`insert into plan_price (id, plan_id, provider, provider_price_id, amount, currency) values (${priceId}, ${planId}, 'stripe', ${key}, 100, 'usd')`
          await tx`insert into subscription (id, workspace_id, plan_id, plan_price_id, provider, provider_subscription_id, status, current_period_start, current_period_end, last_event_at) values (${newId()}, ${ws}, ${planId}, ${priceId}, 'stripe', ${key}, 'active', now(), now()+interval '1 month', now())`
          expect(await resolveWorkspaceMaxSeats(ws, tx)).toBe(5)
          expect(await resolveWorkspaceMaxSeats(newId(), tx)).toBe(DEFAULT_FREE_FEATURES.maxSeats)
          await tx`update subscription set status='past_due', past_due_since=now()-interval '8 days' where workspace_id=${ws}`
          expect(await resolveWorkspaceMaxSeats(ws, tx)).toBe(DEFAULT_FREE_FEATURES.maxSeats)
          // A separate client cannot see these uncommitted rows, proving the test exercises tx.
          expect((await getEntitlements(db, ws)).features.maxSeats).toBe(committed)
          throw new Error('rollback fixture')
        })
        .catch(rollbackFixture)
    } finally {
      await db.$client.end()
    }
  },
)

it.skipIf(!url)(
  'getEntitlements scopes paid subscriptions and rereads time within a transaction',
  async () => {
    const db = createDb(url as string)
    const ws = newId()
    const key = newId()
    const now = new Date()
    try {
      await db
        .transaction(async (tx) => {
          await tx.insert(schema.organization).values({ id: ws, name: 'Entitlements', slug: ws })
          const [plan] = await tx
            .insert(schema.plan)
            .values({
              key,
              name: 'Pro',
              type: 'subscription',
              credits: 0,
              sort: 10,
              features: { ...DEFAULT_FREE_FEATURES, maxSeats: 5 },
            })
            .returning()
          if (!plan) throw new Error('missing plan')
          const [price] = await tx
            .insert(schema.planPrice)
            .values({
              planId: plan.id,
              provider: 'stripe',
              providerPriceId: key,
              amount: 100,
              currency: 'usd',
            })
            .returning()
          if (!price) throw new Error('missing price')
          await tx.insert(schema.subscription).values({
            workspaceId: ws,
            planId: plan.id,
            planPriceId: price.id,
            provider: 'stripe',
            providerSubscriptionId: key,
            status: 'canceled',
            currentPeriodStart: now,
            currentPeriodEnd: new Date(now.getTime() + 86_400_000),
            lastEventAt: now,
          })
          expect((await getEntitlements(tx, ws, { now })).features.maxSeats).toBe(5)
          expect((await getEntitlements(tx, newId(), { now })).key).toBe('free')
          expect(
            (await getEntitlements(tx, ws, { now: new Date(now.getTime() + 2 * 86_400_000) })).key,
          ).toBe('free')
          throw new Error('rollback fixture')
        })
        .catch(rollbackFixture)
    } finally {
      await db.$client.end()
    }
  },
)
