import { describe, expect, it } from 'vitest'
import {
  competition,
  compliance,
  growthSeason,
  marketDemand,
  type ObservationPoint,
  peerSpread,
  profit,
  supplyTiming,
} from '../src/index.ts'
import { ASOF, pt } from './helpers.ts'

describe('市场需求', () => {
  it('eBay：快照差分得 7 天增量，相对 30 天日均的加速度加成（封顶）', () => {
    const result = marketDemand({
      platform: 'ebay',
      asOf: ASOF,
      soldQuantityTotal: [
        {
          entityId: 'item-1',
          points: [pt(100, '2026-09-19'), pt(150, '2026-10-12'), pt(220, '2026-10-19')],
        },
      ],
    })
    // 7 天增量 70 → 68.4，加速度 10/4 = 2.5 倍 → +20
    expect(result.score).toBe(88.4)
    expect(result.detail).toMatchObject({ weeklyUnits: 70, acceleration: 2.5 })
    expect(result.inputs.map((r) => r.observedOn)).toEqual([
      '2026-10-19',
      '2026-10-12',
      '2026-09-19',
    ])
    expect(result.inputs[0]).toMatchObject({
      metric: 'sold_quantity_total',
      entityId: 'item-1',
      sourceId: 'ebay-browse',
      method: 'official',
    })
  })

  it('eBay：没有任何已售数量观测时为空（不是 0）', () => {
    const none = marketDemand({ platform: 'ebay', asOf: ASOF })
    expect(none.score).toBeNull()
    expect(none.reason).toContain('无数据')
    const empty = marketDemand({
      platform: 'ebay',
      asOf: ASOF,
      soldQuantityTotal: [{ entityId: 'x', points: [] }],
    })
    expect(empty.score).toBeNull()
  })

  it('eBay：只有一次快照或快照不足 7 天时为空', () => {
    const result = marketDemand({
      platform: 'ebay',
      asOf: ASOF,
      soldQuantityTotal: [{ entityId: 'x', points: [pt(10, '2026-10-15'), pt(12, '2026-10-19')] }],
    })
    expect(result.score).toBeNull()
  })

  it('eBay：累计已售回退按 0 增量计，分数为 0 而不是空；之后的观测被忽略', () => {
    const result = marketDemand({
      platform: 'ebay',
      asOf: ASOF,
      soldQuantityTotal: [
        {
          entityId: 'x',
          points: [pt(50, '2026-10-12'), pt(40, '2026-10-19'), pt(999, '2026-10-25')],
        },
      ],
    })
    expect(result.score).toBe(0)
  })

  it('eBay：缺少 30 天基线时不加速度加成', () => {
    const result = marketDemand({
      platform: 'ebay',
      asOf: ASOF,
      soldQuantityTotal: [{ entityId: 'x', points: [pt(0, '2026-10-12'), pt(10, '2026-10-19')] }],
    })
    expect(result.score).toBe(37.1)
    expect(result.detail?.acceleration).toBeUndefined()
  })

  it('Amazon：销量估算主值 + BSR 混合；只有 BSR 时只用 BSR；都没有为空', () => {
    const both = marketDemand({
      platform: 'amazon',
      asOf: ASOF,
      salesEstimateMonthly: [
        { entityId: 'B1', points: [pt(1000, '2026-10-18', 'keepa')] },
        { entityId: 'B2', points: [pt(2000, '2026-10-18', 'sellersprite')] },
      ],
      bsr: [{ entityId: 'B1', points: [pt(1000, '2026-10-18', 'keepa')] }],
    })
    // 3000 件 → 66.7；BSR 1000 → 73.0；0.7/0.3 混合
    expect(both.score).toBe(68.6)
    expect(both.detail).toMatchObject({ monthlyUnits: 3000, bestBsr: 1000, salesAvailable: true })

    const bsrOnly = marketDemand({
      platform: 'amazon',
      asOf: ASOF,
      bsr: [{ entityId: 'B1', points: [pt(1000, '2026-10-18', 'keepa')] }],
    })
    expect(bsrOnly.score).toBe(73)
    expect(bsrOnly.detail?.salesAvailable).toBe(false)

    expect(marketDemand({ platform: 'amazon', asOf: ASOF }).score).toBeNull()
  })
})

function seasonalTrend(from: string, months: number): ObservationPoint[] {
  const points: ObservationPoint[] = []
  const start = new Date(`${from}T00:00:00Z`)
  for (let i = 0; i < months; i += 1) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    const month = d.getUTCMonth() + 1
    points.push(
      pt(month === 7 || month === 8 ? 100 : 50, d.toISOString().slice(0, 10), 'dataforseo'),
    )
  }
  return points
}

describe('增长与季节', () => {
  it('多年稳定的季节规律：季节指数 × 年际相关，叠加 90 天增长', () => {
    const result = growthSeason({
      asOf: ASOF,
      keyword: 'back to school',
      trend: seasonalTrend('2024-11-01', 24),
      targetMonths: [7, 8],
    })
    // 指数 100 / 58.33 = 1.71 → 85.7；稳定性 1；90 天从 100 降到 50 → −15
    expect(result.detail).toMatchObject({ seasonIndex: 1.714, seasonStability: 1, growth90: -0.5 })
    expect(result.score).toBe(70.7)
    expect(result.inputs[0]).toMatchObject({
      metric: 'search_trend_index',
      entityId: 'back to school',
    })
  })

  it('只有一年数据时季节分向中性收缩，稳定性不可算', () => {
    const result = growthSeason({
      asOf: ASOF,
      trend: seasonalTrend('2025-11-01', 12),
      targetMonths: [7, 8],
    })
    expect(result.detail?.seasonStability).toBeUndefined()
    expect(result.score).toBe(52.9)
  })

  it('没有趋势序列为空；未关联节点且不足 90 天也为空', () => {
    expect(growthSeason({ asOf: ASOF, trend: [], targetMonths: [7] }).score).toBeNull()
    const short = growthSeason({
      asOf: ASOF,
      trend: [pt(50, '2026-09-01', 'dataforseo'), pt(60, '2026-10-01', 'dataforseo')],
    })
    expect(short.score).toBeNull()
  })

  it('未关联节点时只用 90 天增长（以 50 为基准）', () => {
    const result = growthSeason({
      asOf: ASOF,
      trend: [pt(40, '2026-06-01', 'dataforseo'), pt(60, '2026-10-01', 'dataforseo')],
    })
    expect(result.score).toBe(65)
  })
})

describe('同行扩散', () => {
  const listing = (sellerId: string, firstSeenOn: string, entityId = `${sellerId}-item`) => ({
    entityId,
    sellerId,
    firstSeenOn,
    sourceId: 'ebay-browse',
    method: 'official' as const,
    fetchedAt: `${firstSeenOn}T06:00:00.000Z`,
  })

  it('14 天内上新的对标店铺数与时间集中度；非对标与窗口外的不计', () => {
    const result = peerSpread({
      asOf: ASOF,
      benchmarkSellerIds: ['s1', 's2', 's3'],
      listings: [
        listing('s1', '2026-10-10'),
        listing('s2', '2026-10-12'),
        listing('s4', '2026-10-15'),
        listing('s3', '2026-09-01'),
      ],
    })
    expect(result.detail).toMatchObject({ shops: 2, concentration: 0.857 })
    expect(result.score).toBe(46.9)
    expect(result.inputs).toHaveLength(2)
  })

  it('没有对标店铺或没有上新记录为空；有记录但无人上新为 0', () => {
    expect(peerSpread({ asOf: ASOF, benchmarkSellerIds: [], listings: [] }).score).toBeNull()
    expect(peerSpread({ asOf: ASOF, benchmarkSellerIds: ['s1'], listings: [] }).score).toBeNull()
    const none = peerSpread({
      asOf: ASOF,
      benchmarkSellerIds: ['s1'],
      listings: [listing('s9', '2026-10-15')],
    })
    expect(none.score).toBe(0)
  })

  it('满 5 家且同日上新为 100', () => {
    const result = peerSpread({
      asOf: ASOF,
      benchmarkSellerIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      listings: ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => listing(s, '2026-10-18')),
    })
    expect(result.score).toBe(100)
  })
})

describe('利润空间', () => {
  const prices = [
    { entityId: 'a', points: [pt(20, '2026-10-18')] },
    { entityId: 'b', points: [pt(30, '2026-10-18')] },
    { entityId: 'c', points: [pt(40, '2026-10-18')] },
  ]

  it('竞品中位价下各物流方案中最优的估算毛利率', () => {
    const result = profit({
      platform: 'ebay',
      asOf: ASOF,
      prices,
      landedCosts: [
        { plan: '海运', landedCost: 12 },
        { plan: '空运', landedCost: 16 },
      ],
    })
    // 30 − 13.6% 佣金 − 0.4 − 5% 退货 − 12 = 12.02 → 40.07%
    expect(result.detail).toMatchObject({ medianPrice: 30, bestPlan: '海运', bestMargin: 0.4007 })
    expect(result.score).toBe(80.1)
  })

  it('没有落地成本输入时为空', () => {
    expect(profit({ platform: 'ebay', asOf: ASOF, prices }).score).toBeNull()
    expect(profit({ platform: 'ebay', asOf: ASOF, prices, landedCosts: [] }).score).toBeNull()
  })

  it('没有价格时为空；亏损时为 0', () => {
    expect(
      profit({
        platform: 'amazon',
        asOf: ASOF,
        prices: [],
        landedCosts: [{ plan: 'x', landedCost: 1 }],
      }).score,
    ).toBeNull()
    const loss = profit({
      platform: 'amazon',
      asOf: ASOF,
      prices,
      landedCosts: [{ plan: 'x', landedCost: 40 }],
    })
    expect(loss.score).toBe(0)
    expect(loss.detail?.bestMargin).toBeLessThan(0)
  })
})

describe('利润空间（M3 核算结果）', () => {
  const costed = {
    scenarioId: 's1',
    plan: '义乌工厂 · FBA · 同货源',
    currency: 'USD',
    salePriceMinor: 2999,
    landedCostMinor: 1200,
    grossMargin: 0.25,
    selected: true,
  }

  it('直接采用核算毛利率，来源引用标注 costing_scenario；不再按默认费率估算', () => {
    const result = profit({ platform: 'amazon', asOf: ASOF, prices: [], costed })
    expect(result.score).toBe(50)
    expect(result.detail).toMatchObject({
      bestMargin: 0.25,
      source: 'costing_scenario',
      scenarioId: 's1',
    })
    expect(result.inputs).toEqual([
      expect.objectContaining({
        sourceId: 'costing_scenario',
        entityId: 's1',
        metric: 'gross_margin',
      }),
    ])
    expect(result.reason).toContain('落地成本 12.00 USD')
  })
})

describe('竞争强度（反向）', () => {
  it('卖家数增长、最低价跌幅、评论数中位数取平均', () => {
    const result = competition({
      asOf: ASOF,
      sellerCount: [pt(10, '2026-09-19'), pt(15, '2026-10-19')],
      prices: [
        { entityId: 'a', points: [pt(20, '2026-09-19'), pt(17, '2026-10-19')] },
        { entityId: 'b', points: [pt(25, '2026-10-19')] },
      ],
      reviewCounts: [
        { entityId: 'a', points: [pt(100, '2026-10-19')] },
        { entityId: 'b', points: [pt(50, '2026-10-19')] },
        { entityId: 'c', points: [pt(150, '2026-10-19')] },
      ],
    })
    // 增长 50% → 100；跌幅 15% → 50；中位数 100 → 37.1
    expect(result.detail).toMatchObject({ sellerGrowth: 0.5, priceDrop: 0.15, reviewMedian: 100 })
    expect(result.score).toBe(62.4)
    expect(typeof result.detail?.priceCv).toBe('number')
  })

  it('头部份额单独可算', () => {
    const result = competition({ asOf: ASOF, topShare: pt(0.5, '2026-10-18', 'keepa') })
    expect(result.score).toBe(50)
  })

  it('没有任何输入时为空', () => {
    expect(competition({ asOf: ASOF }).score).toBeNull()
    expect(competition({ asOf: ASOF, sellerCount: [pt(3, '2026-10-19')] }).score).toBeNull()
  })
})

describe('供应与时效（反向）', () => {
  it('默认提前期下的最晚决定日与余量', () => {
    const result = supplyTiming({
      asOf: '2026-05-10',
      platform: 'amazon',
      salesStart: '2026-07-15',
    })
    expect(result.detail).toMatchObject({
      deadline: '2026-05-18',
      slackDays: 8,
      leadDays: 58,
      allPlansLate: false,
      usedDefaultLeadTime: true,
    })
    expect(result.score).toBe(77.6)
  })

  it('有核算组合时采用其最晚决定日，不用默认提前期', () => {
    const costed = { scenarioId: 's1', plan: '海运', deadline: '2026-06-01', leadDays: 44 }
    const ok = supplyTiming({ asOf: '2026-05-10', platform: 'amazon', costed })
    expect(ok.detail).toMatchObject({
      deadline: '2026-06-01',
      slackDays: 22,
      leadDays: 44,
      allPlansLate: false,
      usedDefaultLeadTime: false,
      source: 'costing_scenario',
    })
    expect(ok.inputs[0]).toMatchObject({ sourceId: 'costing_scenario', entityId: 's1' })
    const late = supplyTiming({ asOf: '2026-06-02', platform: 'amazon', costed })
    expect(late.score).toBe(100)
    expect(late.detail?.allPlansLate).toBe(true)
  })

  it('所有物流方案都来不及时为 100 并标记', () => {
    const result = supplyTiming({
      asOf: '2026-05-20',
      platform: 'amazon',
      salesStart: '2026-07-15',
    })
    expect(result.score).toBe(100)
    expect(result.detail?.allPlansLate).toBe(true)
  })

  it('有一个方案来得及就不算来不及，取余量最大的方案', () => {
    const result = supplyTiming({
      asOf: '2026-05-20',
      platform: 'amazon',
      salesStart: '2026-07-15',
      plans: [
        {
          plan: '海运',
          leadTimes: {
            logisticsDays: 35,
            fbaInboundDays: 10,
            procurementDays: 10,
            listingPrepDays: 3,
          },
        },
        {
          plan: '空运',
          leadTimes: {
            logisticsDays: 7,
            fbaInboundDays: 10,
            procurementDays: 10,
            listingPrepDays: 3,
          },
        },
      ],
    })
    expect(result.detail).toMatchObject({ allPlansLate: false, bestPlan: '空运', slackDays: 26 })
    expect(result.score).toBe(12)
  })

  it('未关联节点时为空；余量充足时为 0', () => {
    expect(supplyTiming({ asOf: ASOF, platform: 'ebay' }).score).toBeNull()
    expect(
      supplyTiming({ asOf: '2026-01-01', platform: 'ebay', salesStart: '2026-07-15' }).score,
    ).toBe(0)
  })
})

describe('合规与侵权', () => {
  it('未检查为空；无风险 100；按等级扣分；高风险直接 0 并否决', () => {
    expect(compliance({ asOf: ASOF, findings: null }).score).toBeNull()
    expect(compliance({ asOf: ASOF, findings: [] }).score).toBe(100)
    const medium = compliance({
      asOf: ASOF,
      findings: [
        { type: 'certification', level: 'medium', basis: '需要 FCC 认证' },
        { type: 'design-patent', level: 'low', basis: '可能存在外观专利' },
      ],
    })
    expect(medium.score).toBe(65)
    expect(medium.detail?.veto).toBe(false)
    const high = compliance({
      asOf: ASOF,
      findings: [{ type: 'vero', level: 'high', basis: '品牌在 VeRO 名单' }],
    })
    expect(high.score).toBe(0)
    expect(high.detail?.veto).toBe(true)
    expect(high.reason).toContain('一票否决')
  })
})
