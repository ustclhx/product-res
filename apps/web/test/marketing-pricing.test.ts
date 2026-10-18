import { env } from 'cloudflare:workers'
import { createDb, plan, planPrice } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createPricingCache, PRICING_TTL_MS } from '../src/features/marketing/pricing-data.ts'
import { readPricingCatalog } from '../src/features/marketing/pricing-read.ts'

describe('公开套餐数据库读取', () => {
  it('读取 plan / plan_price，排除失效套餐和价格，缓存到期反映实际价格变更', async () => {
    const db = createDb(env.HYPERDRIVE)
    const refusedDb = createDb(env.HYPERDRIVE_REFUSED)
    const planId = newId()
    const priceId = newId()
    const inactivePlanId = newId()
    try {
      await db.insert(plan).values([
        {
          id: planId,
          key: `pricing-test-${planId}`,
          name: 'Pricing test',
          type: 'subscription',
          credits: 1234,
          features: DEFAULT_FREE_FEATURES,
        },
        {
          id: inactivePlanId,
          key: `pricing-test-${inactivePlanId}`,
          name: 'Hidden plan',
          type: 'subscription',
          credits: 0,
          features: DEFAULT_FREE_FEATURES,
          active: false,
        },
      ])
      await db.insert(planPrice).values([
        {
          id: priceId,
          planId,
          provider: 'stripe',
          providerPriceId: `price_${priceId}`,
          interval: 'month',
          amount: 1900,
          currency: 'USD',
        },
        {
          planId,
          provider: 'stripe',
          providerPriceId: `old_${priceId}`,
          interval: 'month',
          amount: 900,
          currency: 'USD',
          active: false,
        },
        {
          planId: inactivePlanId,
          provider: 'stripe',
          providerPriceId: `hidden_${priceId}`,
          interval: 'month',
          amount: 500,
          currency: 'USD',
        },
      ])
      const snapshot = await readPricingCatalog(db)
      expect(snapshot.plans.find((p) => p.id === planId)?.credits).toBe(1234)
      expect(snapshot.plans.some((p) => p.id === inactivePlanId)).toBe(false)
      expect(snapshot.prices.filter((p) => p.planId === planId)).toMatchObject([
        { id: priceId, amount: 1900 },
      ])
      expect(snapshot.prices.some((p) => p.planId === inactivePlanId)).toBe(false)
      let now = 1000
      const cached = createPricingCache(snapshot, () => now)
      const read = () => readPricingCatalog(db)
      await cached(read)
      await db.update(planPrice).set({ amount: 2900 }).where(eq(planPrice.id, priceId))
      now += PRICING_TTL_MS - 1
      expect((await cached(read)).prices.find((p) => p.id === priceId)?.amount).toBe(1900)
      now++
      expect((await cached(read)).prices.find((p) => p.id === priceId)?.amount).toBe(2900)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      now += PRICING_TTL_MS
      // 数据库不可达时继续展示上次成功读取的价格，不退回构建快照
      expect(
        (await cached(() => readPricingCatalog(refusedDb))).prices.find((p) => p.id === priceId)
          ?.amount,
      ).toBe(2900)
      warn.mockRestore()
    } finally {
      await db.delete(planPrice).where(eq(planPrice.planId, planId))
      await db.delete(planPrice).where(eq(planPrice.planId, inactivePlanId))
      await db.delete(plan).where(eq(plan.id, planId))
      await db.delete(plan).where(eq(plan.id, inactivePlanId))
      await db.$client.end()
      await refusedDb.$client.end()
    }
  })
})
