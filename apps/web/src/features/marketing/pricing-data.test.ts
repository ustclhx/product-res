import { describe, expect, it, vi } from 'vitest'
import { examplePricingCatalog } from '../../../scripts/pricing-snapshot.ts'
import {
  createPricingCache,
  marketingPlans,
  PRICING_RETRY_MS,
  PRICING_TTL_MS,
} from './pricing-data.ts'

describe('公开定价缓存（tasks.md 3.2）', () => {
  it('一小时内复用读取结果，到期后展示更新的价格', async () => {
    const snapshot = examplePricingCatalog()
    let now = 1000
    let amount = 1900
    const read = vi.fn(async () => ({
      ...snapshot,
      prices: snapshot.prices.map((price) => ({ ...price, amount })),
    }))
    const cached = createPricingCache(snapshot, () => now)
    expect((await cached(read)).prices[0]?.amount).toBe(1900)
    amount = 2900
    now += PRICING_TTL_MS - 1
    expect((await cached(read)).prices[0]?.amount).toBe(1900)
    expect(read).toHaveBeenCalledTimes(1)
    now++
    expect((await cached(read)).prices[0]?.amount).toBe(2900)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('数据库不可达时：首次返回构建数据，之后沿用上次成功的数据，并在一分钟后重试', async () => {
    const snapshot = examplePricingCatalog()
    let now = 1000
    const cached = createPricingCache(snapshot, () => now)
    const offline = vi.fn(async () => {
      throw new Error('Database unavailable')
    })
    expect(await cached(offline)).toBe(snapshot)
    await cached(offline)
    expect(offline).toHaveBeenCalledTimes(1)
    // 失败后一分钟即重试，数据库恢复后立即展示实时数据
    const live = { ...snapshot, prices: snapshot.prices.map((p) => ({ ...p, amount: 4900 })) }
    now += PRICING_RETRY_MS
    expect(await cached(async () => live)).toBe(live)
    // 刷新失败时不退回构建快照，继续展示上次成功读取的数据
    now += PRICING_TTL_MS
    expect(await cached(offline)).toBe(live)
    expect(offline).toHaveBeenCalledTimes(2)
    now += PRICING_RETRY_MS - 1
    await cached(offline)
    expect(offline).toHaveBeenCalledTimes(2)
    now++
    await cached(offline)
    expect(offline).toHaveBeenCalledTimes(3)
  })

  it('区块展示套餐的积分、权益与价格，并合并不同支付渠道的同周期报价', () => {
    const plans = marketingPlans(examplePricingCatalog())
    const pro = plans.find((plan) => plan.key === 'pro')
    expect(pro).toMatchObject({ credits: 1000, maxSeats: 1, storageGb: 50 })
    expect(pro?.prices.map((p) => [p.interval, p.amount])).toEqual([
      ['month', 1900],
      ['year', 19000],
    ])
  })
})
