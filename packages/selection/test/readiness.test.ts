import { describe, expect, it } from 'vitest'
import {
  computeConfidence,
  type DimensionResult,
  evaluateLead,
  evaluateReadiness,
  historyHitRateValue,
  type LabeledSample,
  type LabelOutcome,
  readinessLevel,
  type SampleKind,
  wilsonLowerBound,
} from '../src/index.ts'

const ASOF = '2026-10-19'

function samples(
  count: number,
  hitEvery: number,
  kind: SampleKind = 'shadow',
  labeledOn = '2026-09-15',
): LabeledSample[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    outcome: (i % hitEvery === 0 ? 'hit' : 'miss') as LabelOutcome,
    labeledOn,
  }))
}

describe('Wilson 下界', () => {
  it('已知值', () => {
    expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.4038, 4)
    expect(wilsonLowerBound(8, 10)).toBeCloseTo(0.4902, 4)
    expect(wilsonLowerBound(0, 10)).toBe(0)
    expect(wilsonLowerBound(0, 0)).toBeNull()
  })
})

describe('准备度等级（design D3）', () => {
  it('有效样本 19 → 20：冷启动进入观察期，开始显示等级且置信度上限为中', () => {
    const before = evaluateReadiness(samples(19, 2), { asOf: ASOF, baseline: 0.2 })
    const after = evaluateReadiness(samples(20, 2), { asOf: ASOF, baseline: 0.2 })
    expect(before.level).toBe('cold-start')
    expect(after.level).toBe('observation')

    const dims: DimensionResult[] = (
      [
        'market-demand',
        'growth-season',
        'peer-spread',
        'profit',
        'competition',
        'supply-timing',
      ] as const
    ).map((dimension) => ({
      dimension,
      score: dimension === 'competition' || dimension === 'supply-timing' ? 10 : 90,
      inputs: [],
      reason: '',
    }))
    expect(evaluateLead(dims, before.level).displayGrade).toBe('unverified')
    expect(evaluateLead(dims, after.level).displayGrade).toBe('recommended')

    const confidence = computeConfidence({
      now: '2026-10-19T06:00:00.000Z',
      dimensions: dims,
      coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
      memberConfidences: [1],
      lastSyncedAt: '2026-10-19T06:00:00.000Z',
      readiness: after.level,
      historyHitRate: after.stats,
    })
    expect(confidence.value).toBeGreaterThanOrEqual(0.7)
    expect(confidence.level).toBe('medium')
  })

  it('回放与导入按较低权重计入；数据不足不进分母', () => {
    const replay = evaluateReadiness(samples(39, 2, 'replay'), { asOf: ASOF, baseline: 0.2 })
    expect(replay.stats.effectiveSamples).toBe(19.5)
    expect(replay.level).toBe('cold-start')
    const mixed = evaluateReadiness(
      [
        ...samples(10, 2),
        ...samples(20, 2, 'replay'),
        { kind: 'shadow', outcome: 'insufficient', labeledOn: '2026-09-20' },
      ],
      { asOf: ASOF, baseline: 0.2 },
    )
    expect(mixed.stats.effectiveSamples).toBe(20)
    expect(mixed.stats.insufficient).toBe(1)
    expect(mixed.stats.counts).toEqual({ shadow: 10, replay: 20, import: 0 })
    // 权重可配置
    const custom = evaluateReadiness(samples(20, 2, 'import'), {
      asOf: ASOF,
      baseline: 0.2,
      weights: { shadow: 1, replay: 0.5, import: 1 },
    })
    expect(custom.level).toBe('observation')
  })

  it('≥ 50 且下界 ≥ 基线为可用，否则停在观察期', () => {
    const good = evaluateReadiness(samples(60, 2), { asOf: ASOF, baseline: 0.3 })
    expect(good.stats.lowerBound).toBeGreaterThan(0.3)
    expect(good.level).toBe('usable')
    expect(evaluateReadiness(samples(60, 2), { asOf: ASOF, baseline: 0.45 }).level).toBe(
      'observation',
    )
    expect(evaluateReadiness(samples(60, 2), { asOf: ASOF, baseline: null }).level).toBe(
      'observation',
    )
  })

  it('≥ 100、权重已校准、最近 3 个月月度命中率稳定为可信', () => {
    const stable = [
      ...samples(40, 2, 'shadow', '2026-07-10'),
      ...samples(40, 2, 'shadow', '2026-08-10'),
      ...samples(40, 2, 'shadow', '2026-09-10'),
    ]
    const trusted = evaluateReadiness(stable, {
      asOf: ASOF,
      baseline: 0.3,
      weightsCalibrated: true,
    })
    expect(trusted.stats.monthly.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(trusted.stats.monthlyStd).toBe(0)
    expect(trusted.level).toBe('trusted')
    expect(
      evaluateReadiness(stable, { asOf: ASOF, baseline: 0.3, weightsCalibrated: false }).level,
    ).toBe('usable')

    const unstable = [
      ...samples(40, 1, 'shadow', '2026-07-10'),
      ...samples(40, 2, 'shadow', '2026-08-10'),
      ...samples(40, 4, 'shadow', '2026-09-10'),
    ]
    const result = evaluateReadiness(unstable, {
      asOf: ASOF,
      baseline: 0.3,
      weightsCalibrated: true,
    })
    expect(result.stats.monthlyStd).toBeGreaterThan(0.1)
    expect(result.level).toBe('usable')
  })

  it('阈值可配置', () => {
    const input = {
      effectiveSamples: 10,
      lowerBound: 0.5,
      baseline: 0.2,
      weightsCalibrated: false,
      monthlyStd: null,
    }
    expect(readinessLevel(input)).toBe('cold-start')
    expect(
      readinessLevel(input, {
        observation: 5,
        usable: 10,
        trusted: 100,
        stabilityMonths: 3,
        maxMonthlyStd: 0.1,
        minMonthlySamples: 5,
        z: 1.96,
      }),
    ).toBe('usable')
  })
})

describe('历史命中率置信度项', () => {
  const base = {
    now: '2026-10-19T06:00:00.000Z',
    dimensions: [] as DimensionResult[],
    coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
    memberConfidences: [1],
  }

  it('无样本：显示“无样本”，不按 0 计，但降低总置信度', () => {
    const stats = evaluateReadiness([], { asOf: ASOF, baseline: 0.2 }).stats
    expect(historyHitRateValue(stats)).toEqual({ value: null, note: '无样本' })
    const without = computeConfidence(base)
    const withEmpty = computeConfidence({ ...base, historyHitRate: stats })
    expect(withEmpty.items.find((i) => i.id === 'history-hit-rate')).toMatchObject({
      value: null,
      note: '无样本',
    })
    expect(withEmpty.value).toBeLessThan(without.value)
    expect(withEmpty.value).toBeCloseTo(without.value * 0.9, 2)
  })

  it('样本足够时取 Wilson 下界', () => {
    const stats = evaluateReadiness(samples(100, 2), { asOf: ASOF, baseline: 0.2 }).stats
    const result = computeConfidence({ ...base, historyHitRate: stats })
    expect(result.items.find((i) => i.id === 'history-hit-rate')?.value).toBeCloseTo(0.4038, 3)
  })
})
