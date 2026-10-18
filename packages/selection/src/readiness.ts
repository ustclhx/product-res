import type { LabelOutcome } from './labels.ts'
import { mean } from './scales.ts'
import type { Readiness } from './types.ts'

/**
 * 算法准备度（design D3，docs/plan/selection-workbench.md 第 11.2 节）。
 * 按 平台 × 方向 × 信号类型 分组由调用方完成；这里对一组已打标签样本求统计与等级。
 */

/** 样本类型：影子推荐 / Keepa 历史回放 / 导入 */
export type SampleKind = 'shadow' | 'replay' | 'import'

export const SAMPLE_KIND_LABELS: Readonly<Record<SampleKind, string>> = {
  shadow: '影子推荐样本',
  replay: '历史回放样本',
  import: '导入样本',
}

export type SampleWeights = Readonly<Record<SampleKind, number>>

/** 回放与导入的证据弱于影子推荐，按较低权重计入有效样本 */
export const DEFAULT_SAMPLE_WEIGHTS: SampleWeights = { shadow: 1, replay: 0.5, import: 0.3 }

export const READINESS_LABELS: Readonly<Record<Readiness, string>> = {
  'cold-start': '冷启动',
  observation: '观察期',
  usable: '可用',
  trusted: '可信',
}

export interface ReadinessThresholds {
  /** 有效样本达到此数进入观察期 */
  readonly observation: number
  /** 达到此数且下界 ≥ 基线为可用 */
  readonly usable: number
  /** 达到此数、权重已校准且最近几个月稳定为可信 */
  readonly trusted: number
  /** 稳定性统计的完整月份数 */
  readonly stabilityMonths: number
  /** 月度命中率总体标准差上限 */
  readonly maxMonthlyStd: number
  /** 单月有效样本少于此数时该月不可评估，视为不稳定 */
  readonly minMonthlySamples: number
  readonly z: number
}

export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = {
  observation: 20,
  usable: 50,
  trusted: 100,
  stabilityMonths: 3,
  maxMonthlyStd: 0.1,
  minMonthlySamples: 5,
  z: 1.96,
}

/**
 * Wilson 得分区间下界。successes / trials 可为加权（非整数）值；trials ≤ 0 时为 null。
 */
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number | null {
  if (!(trials > 0)) return null
  const p = Math.min(1, Math.max(0, successes / trials))
  const z2 = z * z
  const center = p + z2 / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))
  return Math.max(0, (center - margin) / (1 + z2 / trials))
}

export interface LabeledSample {
  readonly kind: SampleKind
  readonly outcome: LabelOutcome
  /** 打标签日 YYYY-MM-DD；用于月度命中率 */
  readonly labeledOn: string
}

export interface MonthlyHitRate {
  /** YYYY-MM */
  readonly month: string
  readonly effectiveSamples: number
  readonly hitRate: number | null
}

export interface ReadinessStats {
  /** 各类型的样本条数（不含数据不足） */
  readonly counts: Readonly<Record<SampleKind, number>>
  /** 数据不足的条数：只展示，不进分母 */
  readonly insufficient: number
  /** 加权样本数 */
  readonly effectiveSamples: number
  readonly effectiveHits: number
  readonly hitRate: number | null
  readonly lowerBound: number | null
  /** 最近 stabilityMonths 个完整月份（不含计算日所在月），从早到晚 */
  readonly monthly: readonly MonthlyHitRate[]
  /** 月度命中率总体标准差；任一月份样本不足时为 null */
  readonly monthlyStd: number | null
}

const round = (value: number) => Math.round(value * 1000) / 1000

function previousMonths(asOf: string, count: number): string[] {
  const year = Number(asOf.slice(0, 4))
  const month = Number(asOf.slice(5, 7)) - 1
  const months: string[] = []
  for (let i = count; i >= 1; i -= 1) {
    const d = new Date(Date.UTC(year, month - i, 1))
    months.push(d.toISOString().slice(0, 7))
  }
  return months
}

export function readinessStats(
  samples: readonly LabeledSample[],
  asOf: string,
  weights: SampleWeights = DEFAULT_SAMPLE_WEIGHTS,
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): ReadinessStats {
  const counts: Record<SampleKind, number> = { shadow: 0, replay: 0, import: 0 }
  const months = previousMonths(asOf, thresholds.stabilityMonths)
  const byMonth = new Map(months.map((m) => [m, { n: 0, hits: 0 }]))
  let insufficient = 0
  let n = 0
  let hits = 0
  for (const s of samples) {
    if (s.outcome === 'insufficient') {
      insufficient += 1
      continue
    }
    const w = weights[s.kind]
    counts[s.kind] += 1
    n += w
    const hit = s.outcome === 'hit' ? w : 0
    hits += hit
    const bucket = byMonth.get(s.labeledOn.slice(0, 7))
    if (bucket) {
      bucket.n += w
      bucket.hits += hit
    }
  }
  const monthly = months.map((month) => {
    const b = byMonth.get(month) as { n: number; hits: number }
    return {
      month,
      effectiveSamples: round(b.n),
      hitRate: b.n > 0 ? round(b.hits / b.n) : null,
    }
  })
  let monthlyStd: number | null = null
  if (
    monthly.length > 0 &&
    monthly.every((m) => m.effectiveSamples >= thresholds.minMonthlySamples)
  ) {
    const rates = monthly.map((m) => m.hitRate as number)
    const avg = mean(rates) as number
    monthlyStd = round(Math.sqrt(mean(rates.map((r) => (r - avg) ** 2)) as number))
  }
  const lowerBound = wilsonLowerBound(hits, n, thresholds.z)
  return {
    counts,
    insufficient,
    effectiveSamples: round(n),
    effectiveHits: round(hits),
    hitRate: n > 0 ? round(hits / n) : null,
    lowerBound: lowerBound === null ? null : round(lowerBound),
    monthly,
    monthlyStd,
  }
}

export interface ReadinessLevelInput {
  readonly effectiveSamples: number
  readonly lowerBound: number | null
  /** 同方向随机新品的命中率；未知时无法判定可用 */
  readonly baseline: number | null
  /** 当前评分权重是否来自已采用的拟合建议 */
  readonly weightsCalibrated: boolean
  readonly monthlyStd: number | null
}

export function readinessLevel(
  input: ReadinessLevelInput,
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): Readiness {
  const { effectiveSamples: n, lowerBound, baseline } = input
  if (n < thresholds.observation) return 'cold-start'
  // 样本够但下界不及基线（或基线未知）时停在观察期，不放开推荐
  const beatsBaseline = lowerBound !== null && baseline !== null && lowerBound >= baseline
  if (n < thresholds.usable || !beatsBaseline) return 'observation'
  const stable = input.monthlyStd !== null && input.monthlyStd <= thresholds.maxMonthlyStd
  if (n >= thresholds.trusted && input.weightsCalibrated && stable) return 'trusted'
  return 'usable'
}

export interface ReadinessOptions {
  readonly asOf: string
  readonly baseline: number | null
  readonly weightsCalibrated?: boolean | undefined
  readonly weights?: SampleWeights | undefined
  readonly thresholds?: ReadinessThresholds | undefined
}

export interface ReadinessEvaluation {
  readonly level: Readiness
  readonly stats: ReadinessStats
  readonly baseline: number | null
}

/** 统计 + 等级 */
export function evaluateReadiness(
  samples: readonly LabeledSample[],
  options: ReadinessOptions,
): ReadinessEvaluation {
  const thresholds = options.thresholds ?? DEFAULT_READINESS_THRESHOLDS
  const stats = readinessStats(samples, options.asOf, options.weights, thresholds)
  const level = readinessLevel(
    {
      effectiveSamples: stats.effectiveSamples,
      lowerBound: stats.lowerBound,
      baseline: options.baseline,
      weightsCalibrated: options.weightsCalibrated ?? false,
      monthlyStd: stats.monthlyStd,
    },
    thresholds,
  )
  return { level, stats, baseline: options.baseline }
}

/** 置信度“历史命中率”项的输入：同平台、同方向、同信号类型的统计 */
export interface HistoryHitRate {
  readonly effectiveSamples: number
  readonly lowerBound: number | null
}

/**
 * 历史命中率项取值：有效样本少于观察期门槛时为 null（界面显示“无样本”/“样本不足”），绝不按 0 计。
 */
export function historyHitRateValue(
  history: HistoryHitRate,
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): { value: number | null; note: string } {
  if (history.effectiveSamples <= 0) return { value: null, note: '无样本' }
  if (history.effectiveSamples < thresholds.observation || history.lowerBound === null) {
    return { value: null, note: `样本不足（有效样本 ${round(history.effectiveSamples)}）` }
  }
  return {
    value: round(history.lowerBound),
    note: `命中率下界 ${round(history.lowerBound)}（有效样本 ${round(history.effectiveSamples)}）`,
  }
}
