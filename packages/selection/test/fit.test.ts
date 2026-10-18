import { describe, expect, it } from 'vitest'
import { type FitSample, fitWeights, weightedAuc } from '../src/index.ts'

/** 固定种子的线性同余发生器，保证测试数据可复现 */
function lcg(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** 可分数据：命中只由市场需求决定；竞争强度（反向）与命中负相关；其余为噪声 */
function separable(count: number, seed = 7): FitSample[] {
  const rand = lcg(seed)
  return Array.from({ length: count }, (_, i) => {
    const demand = rand() * 100
    const hit = demand > 50
    return {
      scores: {
        'market-demand': demand,
        'growth-season': i % 10 === 0 ? null : rand() * 100,
        'peer-spread': rand() * 100,
        profit: rand() * 100,
        competition: hit ? 20 + rand() * 40 : 40 + rand() * 40,
        'supply-timing': rand() * 100,
        compliance: 90,
      },
      outcome: hit ? 'hit' : 'miss',
      kind: 'shadow',
    }
  })
}

describe('权重拟合（design D5）', () => {
  it('可分数据上收敛，交叉验证 AUC > 0.9，建议权重非负且与当前设置同尺度', () => {
    const result = fitWeights(separable(120))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.converged).toBe(true)
    expect(result.crossValidation.folds).toBe(5)
    expect(result.crossValidation.auc).toBeGreaterThan(0.9)
    expect(result.crossValidation.lift).toBeGreaterThan(0.3)
    const weights = Object.values(result.suggestion.weights)
    expect(weights.every((w) => w >= 0)).toBe(true)
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(7, 1)
    const { weights: w } = result.suggestion
    expect(w['market-demand']).toBeGreaterThan(w['peer-spread'])
    // 竞争强度是反向维度：竞争越低越容易命中 → 建议权重为正
    expect(w.competition).toBeGreaterThan(0)
    expect(result.current.auc).not.toBeNull()
  })

  it('确定性：同样输入得到同样结果', () => {
    expect(fitWeights(separable(80, 3))).toEqual(fitWeights(separable(80, 3)))
  })

  it('有效样本 < 50 拒绝拟合并说明原因（回放按权重折算）', () => {
    const few = fitWeights(separable(49))
    expect(few).toMatchObject({ ok: false, effectiveSamples: 49 })
    if (!few.ok) expect(few.reason).toContain('50')
    const replay = fitWeights(separable(90).map((s) => ({ ...s, kind: 'replay' as const })))
    expect(replay).toMatchObject({ ok: false, effectiveSamples: 45 })
    const withInsufficient = fitWeights([
      ...separable(45),
      ...separable(10).map((s) => ({ ...s, outcome: 'insufficient' as const })),
    ])
    expect(withInsufficient.ok).toBe(false)
  })

  it('只有一类标签时拒绝拟合', () => {
    const allHit = separable(60).map((s) => ({ ...s, outcome: 'hit' as const }))
    expect(fitWeights(allHit).ok).toBe(false)
  })

  it('加权 AUC：完美排序为 1，并列计一半', () => {
    expect(
      weightedAuc([
        { score: 0.1, y: 0, w: 1 },
        { score: 0.9, y: 1, w: 1 },
      ]),
    ).toBe(1)
    expect(
      weightedAuc([
        { score: 0.5, y: 0, w: 1 },
        { score: 0.5, y: 1, w: 1 },
      ]),
    ).toBe(0.5)
    expect(weightedAuc([{ score: 0.5, y: 1, w: 1 }])).toBeNull()
  })
})
