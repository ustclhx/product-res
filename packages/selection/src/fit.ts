import type { LabelOutcome } from './labels.ts'
import { DEFAULT_SAMPLE_WEIGHTS, type SampleKind, type SampleWeights } from './readiness.ts'
import { compositeScore, DEFAULT_SCORING_SETTINGS, type ScoringSettings } from './score.ts'
import { DIMENSIONS, type DimensionId, type DimensionResult } from './types.ts'

/**
 * 权重拟合建议（design D5）：L2 正则逻辑回归 + 分层 5 折交叉验证。
 * 牛顿法求解，折划分按样本顺序确定，结果完全可复现；建议需团队确认后才生成新的评分设置版本。
 */

export interface FitSample {
  /** 冻结时的 7 维分数；缺失维度为 null 或省略 */
  readonly scores: Readonly<Partial<Record<DimensionId, number | null>>>
  /** T+30 标签；数据不足的样本不参与拟合 */
  readonly outcome: LabelOutcome
  readonly kind: SampleKind
}

export interface FitOptions {
  /** 当前评分设置：用于反向维度、权重尺度与对比 */
  readonly settings?: ScoringSettings | undefined
  readonly sampleWeights?: SampleWeights | undefined
  /** L2 强度（作用于标准化后的系数，不含截距） */
  readonly l2?: number | undefined
  readonly folds?: number | undefined
  readonly minEffectiveSamples?: number | undefined
  /** 命中率提升按预测概率最高的这部分样本计算 */
  readonly topFraction?: number | undefined
}

export const DEFAULT_FIT_OPTIONS = {
  l2: 0.1,
  folds: 5,
  minEffectiveSamples: 50,
  topFraction: 0.2,
  maxIterations: 100,
  tolerance: 1e-8,
} as const

export interface RankingMetrics {
  readonly auc: number | null
  /** 全部样本的加权命中率 */
  readonly hitRate: number
  /** 排名前 topFraction 的加权命中率 */
  readonly topHitRate: number | null
  /** topHitRate − hitRate */
  readonly lift: number | null
}

export interface WeightSuggestion {
  /** 非负、与当前设置同尺度（总和相同）的建议权重 */
  readonly weights: Readonly<Record<DimensionId, number>>
  /** 每 1 分的对数几率变化（反向维度已按 100 − 分数换算方向） */
  readonly perPointEffects: Readonly<Record<DimensionId, number>>
  /** 缺失指示的对数几率系数（标准化尺度） */
  readonly missingEffects: Readonly<Record<DimensionId, number>>
}

export type FitResult =
  | {
      readonly ok: true
      readonly effectiveSamples: number
      readonly suggestion: WeightSuggestion
      /** 交叉验证（折外预测）指标 */
      readonly crossValidation: RankingMetrics & { readonly folds: number }
      /** 当前权重的综合分在同一批样本上的排序指标，用于对比 */
      readonly current: RankingMetrics
      readonly iterations: number
      readonly converged: boolean
    }
  | { readonly ok: false; readonly effectiveSamples: number; readonly reason: string }

interface Row {
  readonly scores: readonly (number | null)[]
  readonly y: 0 | 1
  readonly w: number
}

interface Transform {
  readonly fill: readonly number[]
  readonly mu: readonly number[]
  readonly sigma: readonly number[]
}

const round = (value: number, digits = 4) => {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** 特征 = 7 维分数（缺失用样本均值）+ 7 个缺失指示；之后按列标准化 */
function rawFeatures(row: Row, fill: readonly number[]): number[] {
  const values = row.scores.map((s, j) => s ?? (fill[j] as number))
  const missing = row.scores.map((s) => (s === null ? 1 : 0))
  return [...values, ...missing]
}

function fitTransform(rows: readonly Row[]): Transform {
  const fill = DIMENSIONS.map((_, j) => {
    let sum = 0
    let n = 0
    for (const r of rows) {
      const s = r.scores[j]
      if (s === null || s === undefined) continue
      sum += r.w * s
      n += r.w
    }
    return n > 0 ? sum / n : 0
  })
  const raw = rows.map((r) => rawFeatures(r, fill))
  const total = rows.reduce((sum, r) => sum + r.w, 0)
  const width = DIMENSIONS.length * 2
  const mu: number[] = []
  const sigma: number[] = []
  for (let k = 0; k < width; k += 1) {
    let m = 0
    raw.forEach((x, i) => {
      m += (rows[i] as Row).w * (x[k] as number)
    })
    m /= total
    let v = 0
    raw.forEach((x, i) => {
      v += (rows[i] as Row).w * ((x[k] as number) - m) ** 2
    })
    mu.push(m)
    // 常数列标准差记 0，特征恒为 0，L2 使其系数保持 0
    sigma.push(Math.sqrt(v / total))
  }
  return { fill, mu, sigma }
}

function design(row: Row, t: Transform): number[] {
  const x = rawFeatures(row, t.fill).map((v, k) =>
    (t.sigma[k] as number) > 1e-12 ? (v - (t.mu[k] as number)) / (t.sigma[k] as number) : 0,
  )
  return [1, ...x]
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))
const dot = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, v, i) => sum + v * (b[i] as number), 0)

/** 高斯消元（部分主元）解 A x = b */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  for (let c = 0; c < n; c += 1) {
    let pivot = c
    for (let r = c + 1; r < n; r += 1) {
      if (Math.abs((a[r] as number[])[c] as number) > Math.abs((a[pivot] as number[])[c] as number))
        pivot = r
    }
    ;[a[c], a[pivot]] = [a[pivot] as number[], a[c] as number[]]
    ;[b[c], b[pivot]] = [b[pivot] as number, b[c] as number]
    const rowC = a[c] as number[]
    const p = rowC[c] as number
    for (let r = c + 1; r < n; r += 1) {
      const rowR = a[r] as number[]
      const f = (rowR[c] as number) / p
      if (f === 0) continue
      for (let k = c; k < n; k += 1) rowR[k] = (rowR[k] as number) - f * (rowC[k] as number)
      b[r] = (b[r] as number) - f * (b[c] as number)
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r -= 1) {
    const row = a[r] as number[]
    let s = b[r] as number
    for (let k = r + 1; k < n; k += 1) s -= (row[k] as number) * (x[k] as number)
    x[r] = s / (row[r] as number)
  }
  return x
}

interface Model {
  readonly beta: readonly number[]
  readonly transform: Transform
  readonly iterations: number
  readonly converged: boolean
}

/** 加权平均对数损失 + (l2 / 2)‖β‖²（不含截距），牛顿法 */
function train(rows: readonly Row[], l2: number): Model {
  const transform = fitTransform(rows)
  const xs = rows.map((r) => design(r, transform))
  const total = rows.reduce((sum, r) => sum + r.w, 0)
  const width = (xs[0] as number[]).length
  let beta = new Array<number>(width).fill(0)
  let iterations = 0
  let converged = false
  while (iterations < DEFAULT_FIT_OPTIONS.maxIterations) {
    iterations += 1
    const grad = beta.map((b, k) => (k === 0 ? 0 : l2 * b))
    const hess = Array.from({ length: width }, (_, i) =>
      Array.from({ length: width }, (_, j) => (i === j ? (i === 0 ? 1e-9 : l2) : 0)),
    )
    xs.forEach((x, i) => {
      const row = rows[i] as Row
      const p = sigmoid(dot(beta, x))
      const wi = row.w / total
      const r = wi * (p - row.y)
      const h = wi * p * (1 - p)
      for (let a = 0; a < width; a += 1) {
        grad[a] = (grad[a] as number) + r * (x[a] as number)
        const ha = hess[a] as number[]
        for (let b = 0; b < width; b += 1)
          ha[b] = (ha[b] as number) + h * (x[a] as number) * (x[b] as number)
      }
    })
    const step = solve(hess, grad)
    beta = beta.map((b, k) => b - (step[k] as number))
    if (Math.max(...step.map(Math.abs)) < DEFAULT_FIT_OPTIONS.tolerance) {
      converged = true
      break
    }
  }
  return { beta, transform, iterations, converged }
}

const predict = (model: Model, row: Row) => sigmoid(dot(model.beta, design(row, model.transform)))

/** 加权 AUC（并列计一半）；只有一类时为 null */
export function weightedAuc(
  items: readonly { readonly score: number; readonly y: 0 | 1; readonly w: number }[],
): number | null {
  const sorted = [...items].sort((a, b) => a.score - b.score)
  let pos = 0
  let neg = 0
  let negBelow = 0
  let area = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i
    let gp = 0
    let gn = 0
    while (
      j < sorted.length &&
      (sorted[j] as (typeof sorted)[number]).score === (sorted[i] as (typeof sorted)[number]).score
    ) {
      const it = sorted[j] as (typeof sorted)[number]
      if (it.y === 1) gp += it.w
      else gn += it.w
      j += 1
    }
    area += gp * (negBelow + gn / 2)
    negBelow += gn
    pos += gp
    neg += gn
    i = j
  }
  return pos > 0 && neg > 0 ? area / (pos * neg) : null
}

function rankingMetrics(
  items: readonly { readonly score: number; readonly y: 0 | 1; readonly w: number }[],
  topFraction: number,
): RankingMetrics {
  const total = items.reduce((sum, it) => sum + it.w, 0)
  const hitRate = total > 0 ? items.reduce((sum, it) => sum + it.w * it.y, 0) / total : 0
  const top = [...items]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.ceil(items.length * topFraction))
  const topTotal = top.reduce((sum, it) => sum + it.w, 0)
  const topHitRate = topTotal > 0 ? top.reduce((sum, it) => sum + it.w * it.y, 0) / topTotal : null
  const auc = weightedAuc(items)
  return {
    auc: auc === null ? null : round(auc),
    hitRate: round(hitRate),
    topHitRate: topHitRate === null ? null : round(topHitRate),
    lift: topHitRate === null ? null : round(topHitRate - hitRate),
  }
}

export function fitWeights(samples: readonly FitSample[], options: FitOptions = {}): FitResult {
  const settings = options.settings ?? DEFAULT_SCORING_SETTINGS
  const sampleWeights = options.sampleWeights ?? DEFAULT_SAMPLE_WEIGHTS
  const l2 = options.l2 ?? DEFAULT_FIT_OPTIONS.l2
  const folds = options.folds ?? DEFAULT_FIT_OPTIONS.folds
  const minEffective = options.minEffectiveSamples ?? DEFAULT_FIT_OPTIONS.minEffectiveSamples
  const topFraction = options.topFraction ?? DEFAULT_FIT_OPTIONS.topFraction

  const rows: Row[] = samples
    .filter((s) => s.outcome !== 'insufficient')
    .map((s) => ({
      scores: DIMENSIONS.map((id) => {
        const v = s.scores[id]
        return v === null || v === undefined || !Number.isFinite(v) ? null : v
      }),
      y: s.outcome === 'hit' ? 1 : 0,
      w: sampleWeights[s.kind],
    }))
  const effectiveSamples = round(
    rows.reduce((sum, r) => sum + r.w, 0),
    3,
  )
  if (effectiveSamples < minEffective) {
    return {
      ok: false,
      effectiveSamples,
      reason: `有效样本 ${effectiveSamples} 少于拟合下限 ${minEffective}`,
    }
  }
  const positives = rows.filter((r) => r.y === 1).length
  const negatives = rows.length - positives
  if (Math.min(positives, negatives) < folds) {
    return {
      ok: false,
      effectiveSamples,
      reason: `命中 ${positives} 条、未命中 ${negatives} 条，任一类少于 ${folds} 条无法交叉验证`,
    }
  }

  // 分层折：按标签分组后轮流分配，保证每折两类都有；不依赖随机数
  const foldOf = new Array<number>(rows.length)
  let counter = 0
  for (const label of [1, 0] as const) {
    rows.forEach((r, i) => {
      if (r.y !== label) return
      foldOf[i] = counter % folds
      counter += 1
    })
  }
  const outOfFold: { score: number; y: 0 | 1; w: number }[] = []
  for (let f = 0; f < folds; f += 1) {
    const trainRows = rows.filter((_, i) => foldOf[i] !== f)
    const model = train(trainRows, l2)
    rows.forEach((r, i) => {
      if (foldOf[i] === f) outOfFold.push({ score: predict(model, r), y: r.y, w: r.w })
    })
  }

  const model = train(rows, l2)
  const reversed = new Set(settings.reversed)
  const n = DIMENSIONS.length
  const perPoint = DIMENSIONS.map((id, j) => {
    const sigma = model.transform.sigma[j] as number
    const effect = sigma > 1e-12 ? (model.beta[j + 1] as number) / sigma : 0
    // 综合分对反向维度用 100 − 分数，所以对应权重方向取反
    return reversed.has(id) ? -effect : effect
  })
  const positive = perPoint.map((e) => Math.max(0, e))
  const positiveSum = positive.reduce((a, b) => a + b, 0)
  if (positiveSum <= 0) {
    return {
      ok: false,
      effectiveSamples,
      reason: '所有维度与命中都不呈正相关，无法给出非负权重建议',
    }
  }
  const currentSum = DIMENSIONS.reduce((sum, id) => sum + settings.weights[id], 0)
  const scale = (currentSum > 0 ? currentSum : n) / positiveSum
  const record = (values: readonly number[], digits: number) =>
    Object.fromEntries(
      DIMENSIONS.map((id, j) => [id, round(values[j] as number, digits)]),
    ) as Record<DimensionId, number>

  const current = rows.flatMap((r) => {
    const dims: DimensionResult[] = DIMENSIONS.map((id, j) => ({
      dimension: id,
      score: r.scores[j] ?? null,
      inputs: [],
      reason: '',
    }))
    const score = compositeScore(dims, settings).score
    return score === null ? [] : [{ score, y: r.y, w: r.w }]
  })

  return {
    ok: true,
    effectiveSamples,
    suggestion: {
      weights: record(
        positive.map((e) => e * scale),
        2,
      ),
      perPointEffects: record(perPoint, 4),
      missingEffects: record(
        DIMENSIONS.map((_, j) => model.beta[n + j + 1] as number),
        4,
      ),
    },
    crossValidation: { ...rankingMetrics(outOfFold, topFraction), folds },
    current: rankingMetrics(current, topFraction),
    iterations: model.iterations,
    converged: model.converged,
  }
}
