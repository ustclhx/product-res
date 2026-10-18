import { describe, expect, it } from 'vitest'
import {
  addDays,
  dueWindows,
  type LabelObservation,
  labelDueOn,
  labelRecommendation,
} from '../src/index.ts'

const FROZEN = '2026-09-01'

/** 冻结日后第 1..days 天的序列；skip 返回 true 的天记为缺失 */
function series(
  days: number,
  value: (day: number) => number,
  sourceId: string,
  skip: (day: number) => boolean = () => false,
): LabelObservation[] {
  return Array.from({ length: days }, (_, i) => ({
    observedOn: addDays(FROZEN, i + 1),
    value: skip(i + 1) ? null : value(i + 1),
    sourceId,
  }))
}

/** 冻结日基准价 100，窗口末跌到 100 × (1 − drop) */
function prices(days: number, drop: number): LabelObservation[] {
  return [
    { observedOn: FROZEN, value: 100, sourceId: 'ebay-browse' },
    ...series(days, (d) => 100 - (100 * drop * d) / days, 'ebay-browse'),
  ]
}

describe('到期打标签（design D2）', () => {
  it('30 天销量增量 45 件、竞品中位价跌 8%（X=30、Y=15）→ 命中', () => {
    const result = labelRecommendation({
      frozenOn: FROZEN,
      window: 30,
      dailySales: series(30, () => 1.5, 'ebay-snapshot'),
      medianPrices: prices(30, 0.08),
    })
    expect(result.outcome).toBe('hit')
    expect(result.salesIncrement).toBe(45)
    expect(result.priceDrop).toBeCloseTo(0.08, 4)
    expect(result.sources).toEqual(['ebay-browse', 'ebay-snapshot'])
  })

  it('30 天中只有 10 天有销量观测 → 数据不足', () => {
    const result = labelRecommendation({
      frozenOn: FROZEN,
      window: 30,
      dailySales: series(
        30,
        () => 5,
        'ebay-snapshot',
        (d) => d > 10,
      ),
      medianPrices: prices(30, 0),
    })
    expect(result.outcome).toBe('insufficient')
    expect(result.coverage.sales).toBeCloseTo(0.333, 3)
    expect(result.reason).toContain('10 天')
  })

  it('恰好一半有观测不算数据不足，按日均外推增量', () => {
    const result = labelRecommendation({
      frozenOn: FROZEN,
      window: 30,
      dailySales: series(
        30,
        () => 2,
        'keepa',
        (d) => d % 2 === 0,
      ),
      medianPrices: prices(30, 0.05),
    })
    expect(result.outcome).toBe('hit')
    expect(result.salesIncrement).toBe(60)
  })

  it('销量不足或价格跌幅过大 → 未命中；X、Y 可配置', () => {
    const lowSales = labelRecommendation({
      frozenOn: FROZEN,
      window: 30,
      dailySales: series(30, () => 0.5, 'ebay-snapshot'),
      medianPrices: prices(30, 0),
    })
    expect(lowSales.outcome).toBe('miss')
    const crash = {
      frozenOn: FROZEN,
      window: 30 as const,
      dailySales: series(30, () => 3, 'ebay-snapshot'),
      medianPrices: prices(30, 0.2),
    }
    const priceCrash = labelRecommendation(crash)
    expect(priceCrash.outcome).toBe('miss')
    expect(priceCrash.reason).toContain('20%')
    expect(
      labelRecommendation(crash, {
        minUnits: 30,
        maxPriceDrop: 0.25,
        maxPeakErrorWeeks: 2,
        minCoverage: 0.5,
      }).outcome,
    ).toBe('hit')
  })

  it('只统计窗口内观测；缺少冻结日基准价 → 数据不足', () => {
    const result = labelRecommendation({
      frozenOn: FROZEN,
      window: 14,
      dailySales: series(60, () => 3, 'ebay-snapshot'),
      medianPrices: series(14, () => 100, 'ebay-browse'),
    })
    expect(result.salesIncrement).toBe(42)
    expect(result.outcome).toBe('insufficient')
    expect(result.reason).toContain('冻结日')
  })

  it('季节类高峰周误差 ≤ 2 周才命中；缺高峰周为数据不足', () => {
    const base = {
      frozenOn: FROZEN,
      window: 60 as const,
      dailySales: series(60, () => 1, 'ebay-snapshot'),
      medianPrices: prices(60, 0.05),
    }
    expect(
      labelRecommendation({
        ...base,
        season: { predictedPeakWeek: '2026-10-05', actualPeakWeek: '2026-10-19' },
      }).outcome,
    ).toBe('hit')
    const late = labelRecommendation({
      ...base,
      season: { predictedPeakWeek: '2026-10-05', actualPeakWeek: '2026-10-26' },
    })
    expect(late.outcome).toBe('miss')
    expect(late.peakErrorWeeks).toBe(3)
    expect(
      labelRecommendation({
        ...base,
        season: { predictedPeakWeek: '2026-10-05', actualPeakWeek: null },
      }).outcome,
    ).toBe('insufficient')
  })

  it('到期判断：冻结日 + 窗口 ≤ 今天且未打标签', () => {
    expect(labelDueOn(FROZEN, 30)).toBe('2026-10-01')
    expect(dueWindows(FROZEN, '2026-09-14')).toEqual([])
    expect(dueWindows(FROZEN, '2026-09-15')).toEqual([14])
    expect(dueWindows(FROZEN, '2026-10-01', [14])).toEqual([30])
    expect(dueWindows(FROZEN, '2026-12-31', [14, 30, 60])).toEqual([])
  })
})
