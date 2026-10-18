import { describe, expect, it } from 'vitest'
import {
  compositeScore,
  computeConfidence,
  DEFAULT_SCORING_SETTINGS,
  type DimensionId,
  type DimensionResult,
  evaluateGates,
  evaluateLead,
  GRADE_LABELS,
  gradeOf,
  rankKey,
} from '../src/index.ts'

function dims(
  scores: Partial<Record<DimensionId, number | null>>,
  detail: Partial<Record<DimensionId, DimensionResult['detail']>> = {},
): DimensionResult[] {
  return Object.entries(scores).map(([dimension, score]) => ({
    dimension: dimension as DimensionId,
    score: score ?? null,
    inputs: [],
    reason: '',
    detail: detail[dimension as DimensionId],
  }))
}

describe('综合分', () => {
  it('已计算维度按权重归一，反向维度取 100 − 分数', () => {
    const result = compositeScore(
      dims({ 'market-demand': 80, 'growth-season': 60, competition: 30, compliance: 90 }),
    )
    expect(result.score).toBe(75)
    expect(result.used).toEqual(['market-demand', 'growth-season', 'competition', 'compliance'])
    expect(result.missing).toEqual(['peer-spread', 'profit', 'supply-timing'])
  })

  it('缺失维度不按 0 计（specs/selection-scoring：缺少销量数据）', () => {
    const withMissing = compositeScore(
      dims({
        'market-demand': null,
        'growth-season': 70,
        'peer-spread': 70,
        competition: 30,
        compliance: 70,
      }),
    )
    expect(withMissing.score).toBe(70)
    expect(withMissing.missing).toContain('market-demand')
    // 若把缺失当 0，分数会被拉低到 56
    const asZero = compositeScore(
      dims({
        'market-demand': 0,
        'growth-season': 70,
        'peer-spread': 70,
        competition: 30,
        compliance: 70,
      }),
    )
    expect(asZero.score).toBe(56)
  })

  it('可计算维度少于 4 个时不给综合分', () => {
    const result = compositeScore(
      dims({ 'market-demand': 90, 'growth-season': 90, compliance: 90, profit: null }),
    )
    expect(result.score).toBeNull()
    expect(evaluateLead(dims({ 'market-demand': 90 }), 'usable').grade).toBeNull()
  })

  it('权重变化只影响按该设置计算的结果，并记录版本', () => {
    const input = dims({
      'market-demand': 100,
      'growth-season': 40,
      'peer-spread': 40,
      compliance: 40,
    })
    expect(compositeScore(input).score).toBe(55)
    const v2 = {
      ...DEFAULT_SCORING_SETTINGS,
      version: 2,
      weights: { ...DEFAULT_SCORING_SETTINGS.weights, 'market-demand': 2 },
    }
    expect(compositeScore(input, v2).score).toBe(64)
    expect(evaluateLead(input, 'usable', v2).settingsVersion).toBe(2)
    expect(evaluateLead(input, 'usable').settingsVersion).toBe(1)
  })
})

describe('硬门槛与等级', () => {
  it('一票否决：综合分 82 但合规 20 → 不推荐，原因为合规低于否决阈值', () => {
    const input = dims({
      'market-demand': 100,
      'growth-season': 95,
      'peer-spread': 92,
      profit: 95,
      competition: 10,
      compliance: 20,
    })
    const lead = evaluateLead(input, 'usable')
    expect(lead.composite.score).toBe(82)
    expect(lead.gates.passed).toBe(false)
    expect(lead.gates.failures).toEqual([{ gate: 'compliance', reason: '合规与侵权低于否决阈值' }])
    expect(lead.grade).toBe('not-recommended')
    expect(lead.displayGrade).toBe('not-recommended')
    // 冷启动下硬门槛不通过仍显示不推荐
    expect(evaluateLead(input, 'cold-start').displayGrade).toBe('not-recommended')
  })

  it('所有物流方案都来不及、毛利率低于底线；无利润数据时不判毛利', () => {
    expect(
      evaluateGates({ complianceScore: 80, allPlansLate: true, bestMargin: 0.3 }).failures,
    ).toEqual([{ gate: 'timing', reason: '所有物流方案都来不及' }])
    expect(
      evaluateGates({ complianceScore: 80, allPlansLate: false, bestMargin: 0.1 }).failures,
    ).toEqual([{ gate: 'margin', reason: '毛利率低于底线' }])
    expect(
      evaluateGates({ complianceScore: null, allPlansLate: null, bestMargin: null }).passed,
    ).toBe(true)
    expect(
      evaluateGates({ complianceScore: 30, allPlansLate: null, bestMargin: 0.15 }).passed,
    ).toBe(true)
  })

  it('门槛输入从维度明细读取', () => {
    const lead = evaluateLead(
      dims(
        {
          'market-demand': 90,
          'growth-season': 90,
          'peer-spread': 90,
          profit: 20,
          'supply-timing': 10,
          compliance: 100,
        },
        { profit: { bestMargin: 0.1 }, 'supply-timing': { allPlansLate: false } },
      ),
      'usable',
    )
    expect(lead.gates.failures.map((f) => f.gate)).toEqual(['margin'])
  })

  it('等级边界：≥ 75 推荐，50–74 谨慎，< 50 不推荐', () => {
    expect(gradeOf(75)).toBe('recommended')
    expect(gradeOf(74.9)).toBe('caution')
    expect(gradeOf(50)).toBe('caution')
    expect(gradeOf(49.9)).toBe('not-recommended')
  })

  it('冷启动：显示“未验证”，保存计算等级，排序仍用综合分 × 置信度', () => {
    const input = dims({
      'market-demand': 90,
      'growth-season': 80,
      'peer-spread': 80,
      competition: 20,
      compliance: 100,
    })
    const lead = evaluateLead(input, 'cold-start')
    expect(lead.composite.score).toBe(86)
    expect(lead.grade).toBe('recommended')
    expect(lead.displayGrade).toBe('unverified')
    expect(GRADE_LABELS[lead.displayGrade as 'unverified']).toBe('未验证')
    const confidence = computeConfidence({
      now: '2026-10-19T06:00:00.000Z',
      dimensions: input,
      coverage: { snapshotDays: 30, memberCount: 5, sellerCount: 3 },
      memberConfidences: [1],
    })
    expect(rankKey(lead.composite.score, confidence.value)).toBe(
      Math.round((lead.composite.score as number) * confidence.value * 100) / 100,
    )
    expect(evaluateLead(input, 'usable').displayGrade).toBe('recommended')
  })
})
