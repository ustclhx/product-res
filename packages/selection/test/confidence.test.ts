import { describe, expect, it } from 'vitest'
import {
  ATTENTION_LABEL,
  type ConfidenceItemId,
  computeConfidence,
  confidenceLevel,
  type DimensionResult,
  needsAttention,
  rankKey,
  type SourceRef,
} from '../src/index.ts'

const NOW = '2026-10-19T06:00:00.000Z'

function ref(metric: string, sourceId: string, value: number, fetchedAt = NOW): SourceRef {
  return {
    metric,
    sourceId,
    value,
    entityId: 'B1',
    observedOn: '2026-10-18',
    method: 'estimate',
    fetchedAt,
  }
}

function item(result: ReturnType<typeof computeConfidence>, id: ConfidenceItemId) {
  return result.items.find((i) => i.id === id)
}

const strong: DimensionResult[] = [
  {
    dimension: 'market-demand',
    score: 80,
    inputs: [
      ref('sales_estimate_monthly', 'keepa', 1000),
      ref('sales_estimate_monthly', 'sellersprite', 1040),
    ],
    reason: '',
    detail: { salesAvailable: true },
  },
  {
    dimension: 'growth-season',
    score: 70,
    inputs: [],
    reason: '',
    detail: { seasonStability: 0.9 },
  },
  { dimension: 'peer-spread', score: 60, inputs: [], reason: '' },
  {
    dimension: 'supply-timing',
    score: 10,
    inputs: [],
    reason: '',
    detail: { slackDays: 60, leadDays: 58, usedDefaultLeadTime: false },
  },
  {
    dimension: 'competition',
    score: 30,
    inputs: [],
    reason: '',
    detail: { priceCv: 0.03, sellerGrowth: 0.05 },
  },
]

describe('置信度：成本确定性（M3）', () => {
  const base = {
    now: NOW,
    dimensions: strong,
    coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
    memberConfidences: [1],
  }

  it('传入核算的成本确定性时计入平均；未核算为空且不计入；省略时没有该项', () => {
    const without = computeConfidence(base)
    expect(item(without, 'cost-certainty')).toBeUndefined()
    const empty = computeConfidence({ ...base, costCertainty: null })
    expect(item(empty, 'cost-certainty')).toMatchObject({ value: null, note: '未核算' })
    expect(empty.value).toBe(without.value)
    const low = computeConfidence({ ...base, costCertainty: 0.3 })
    expect(item(low, 'cost-certainty')?.value).toBe(0.3)
    expect(low.value).toBeLessThan(without.value)
  })
})

describe('置信度（design D6）', () => {
  it('证据充足、多来源一致时为高', () => {
    const result = computeConfidence({
      now: NOW,
      dimensions: strong,
      coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
      memberConfidences: [1, 0.95],
    })
    expect(result.items).toHaveLength(8)
    expect(item(result, 'coverage')?.value).toBe(1)
    expect(item(result, 'freshness')?.value).toBe(1)
    expect(item(result, 'signal-consistency')?.value).toBe(1)
    expect(item(result, 'source-consistency')?.value).toBeGreaterThan(0.9)
    expect(item(result, 'season-stability')?.value).toBe(0.9)
    expect(item(result, 'time-slack')?.value).toBe(1)
    expect(item(result, 'competition-stability')?.value).toBeCloseTo(0.9, 2)
    expect(result.unverifiedMetrics).toEqual([])
    expect(result.level).toBe('high')
  })

  it('只有单一来源的指标标“未交叉验证”', () => {
    const result = computeConfidence({
      now: NOW,
      dimensions: [
        {
          dimension: 'market-demand',
          score: 80,
          inputs: [ref('sold_quantity_total', 'ebay-browse', 10)],
          reason: '',
        },
      ],
      coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
      memberConfidences: [1],
    })
    expect(result.unverifiedMetrics).toEqual(['sold_quantity_total'])
    expect(item(result, 'source-consistency')).toMatchObject({ value: 0.5, note: '未交叉验证' })
  })

  it('来源说法不一致、数据陈旧、不可算项不计入平均', () => {
    const result = computeConfidence({
      now: NOW,
      dimensions: [
        {
          dimension: 'market-demand',
          score: 80,
          inputs: [
            ref('sales_estimate_monthly', 'keepa', 100, '2026-10-01T00:00:00.000Z'),
            ref('sales_estimate_monthly', 'sellersprite', 1000, '2026-10-01T00:00:00.000Z'),
          ],
          reason: '',
        },
      ],
      coverage: { snapshotDays: 3, memberCount: 1, sellerCount: 1 },
      memberConfidences: [],
    })
    expect(item(result, 'source-consistency')?.value).toBe(0)
    expect(item(result, 'freshness')?.value).toBe(0)
    expect(item(result, 'merge')?.value).toBeNull()
    expect(item(result, 'season-stability')?.value).toBeNull()
    expect(item(result, 'time-slack')?.value).toBeNull()
    expect(item(result, 'competition-stability')?.value).toBeNull()
    expect(result.level).toBe('low')
  })

  it('只用默认提前期时时间余量减半；观察期置信度上限为中', () => {
    const dims = strong.map((d) =>
      d.dimension === 'supply-timing'
        ? { ...d, detail: { slackDays: 60, leadDays: 58, usedDefaultLeadTime: true } }
        : d,
    )
    const result = computeConfidence({
      now: NOW,
      dimensions: dims,
      coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
      memberConfidences: [1],
      readiness: 'observation',
    })
    expect(item(result, 'time-slack')?.value).toBe(0.5)
    expect(result.value).toBeGreaterThanOrEqual(0.7)
    expect(result.level).toBe('medium')
  })

  it('分档边界', () => {
    expect(confidenceLevel(0.7)).toBe('high')
    expect(confidenceLevel(0.69)).toBe('medium')
    expect(confidenceLevel(0.4)).toBe('medium')
    expect(confidenceLevel(0.39)).toBe('low')
  })

  it('高分低置信：综合分 80、置信度低 → 值得关注但证据不足', () => {
    expect(needsAttention(80, 'low')).toBe(true)
    expect(ATTENTION_LABEL).toBe('值得关注但证据不足')
    expect(needsAttention(80, 'medium')).toBe(false)
    expect(needsAttention(60, 'low')).toBe(false)
    expect(needsAttention(null, 'low')).toBe(false)
  })

  it('排序键 = 综合分 × 置信度；无综合分排最后', () => {
    expect(rankKey(80, 0.3)).toBe(24)
    expect(rankKey(60, 0.9)).toBe(54)
    expect(rankKey(null, 1)).toBeLessThan(rankKey(0, 0))
  })
})
