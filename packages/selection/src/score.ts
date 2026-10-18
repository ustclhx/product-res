import { clampScore } from './scales.ts'
import { DIMENSIONS, type DimensionId, type DimensionResult, type Readiness } from './types.ts'

/**
 * 综合分、硬门槛与等级（design D5，docs/plan/selection-workbench.md 第 5.2 节）。
 */

export interface ScoringSettings {
  /** 权重版本号；线索记录所用版本 */
  readonly version: number
  readonly weights: Readonly<Record<DimensionId, number>>
  /** 反向维度：参与综合分时取 100 − 分数 */
  readonly reversed: readonly DimensionId[]
  /** 合规分低于此值一票否决 */
  readonly vetoThreshold: number
  /** 可计算维度少于此数不给综合分 */
  readonly minDimensions: number
  /** 毛利率底线（0–1） */
  readonly marginFloor: number
  readonly gates: {
    readonly compliance: boolean
    readonly timing: boolean
    readonly margin: boolean
  }
}

/** 默认评分设置：等权起步（M5 回测拟合后由团队确认替换） */
export const DEFAULT_SCORING_SETTINGS: ScoringSettings = {
  version: 1,
  weights: {
    'market-demand': 1,
    'growth-season': 1,
    'peer-spread': 1,
    profit: 1,
    competition: 1,
    'supply-timing': 1,
    compliance: 1,
  },
  reversed: ['competition', 'supply-timing'],
  vetoThreshold: 30,
  minDimensions: 4,
  marginFloor: 0.15,
  gates: { compliance: true, timing: true, margin: true },
}

export interface CompositeResult {
  /** 少于 minDimensions 个维度可计算时为 null */
  readonly score: number | null
  readonly used: readonly DimensionId[]
  readonly missing: readonly DimensionId[]
}

/** 综合分 = Σ(权重 × 分数') ÷ Σ(已计算维度的权重)；缺失维度不参与，也不按 0 计 */
export function compositeScore(
  dimensions: readonly DimensionResult[],
  settings: ScoringSettings = DEFAULT_SCORING_SETTINGS,
): CompositeResult {
  const byId = new Map(dimensions.map((d) => [d.dimension, d]))
  const reversed = new Set(settings.reversed)
  const used: DimensionId[] = []
  const missing: DimensionId[] = []
  let weighted = 0
  let weightSum = 0
  for (const id of DIMENSIONS) {
    const score = byId.get(id)?.score
    const weight = settings.weights[id]
    if (score === null || score === undefined) {
      missing.push(id)
      continue
    }
    used.push(id)
    if (weight <= 0) continue
    weighted += weight * (reversed.has(id) ? 100 - score : score)
    weightSum += weight
  }
  const score =
    used.length < settings.minDimensions || weightSum === 0
      ? null
      : clampScore(weighted / weightSum)
  return { score, used, missing }
}

export type GateId = 'compliance' | 'timing' | 'margin'

export interface GateFailure {
  readonly gate: GateId
  readonly reason: string
}

export interface GateInput {
  /** 合规维度分；未检查时为 null（不判） */
  readonly complianceScore: number | null
  /** 所有物流方案都来不及；无节点时为 null（不判） */
  readonly allPlansLate: boolean | null
  /** 各物流方案中最优的毛利率；无利润数据时为 null（不判） */
  readonly bestMargin: number | null
}

export interface GateResult {
  readonly passed: boolean
  readonly failures: readonly GateFailure[]
}

export const GATE_REASONS: Readonly<Record<GateId, string>> = {
  compliance: '合规与侵权低于否决阈值',
  timing: '所有物流方案都来不及',
  margin: '毛利率低于底线',
}

/** 从维度结果中取门槛输入 */
export function gateInputFrom(dimensions: readonly DimensionResult[]): GateInput {
  const byId = new Map(dimensions.map((d) => [d.dimension, d]))
  const late = byId.get('supply-timing')?.detail?.allPlansLate
  const margin = byId.get('profit')?.detail?.bestMargin
  return {
    complianceScore: byId.get('compliance')?.score ?? null,
    allPlansLate: typeof late === 'boolean' ? late : null,
    bestMargin: typeof margin === 'number' ? margin : null,
  }
}

export function evaluateGates(
  input: GateInput,
  settings: ScoringSettings = DEFAULT_SCORING_SETTINGS,
): GateResult {
  const failures: GateFailure[] = []
  if (
    settings.gates.compliance &&
    input.complianceScore !== null &&
    input.complianceScore < settings.vetoThreshold
  ) {
    failures.push({ gate: 'compliance', reason: GATE_REASONS.compliance })
  }
  if (settings.gates.timing && input.allPlansLate === true) {
    failures.push({ gate: 'timing', reason: GATE_REASONS.timing })
  }
  if (
    settings.gates.margin &&
    input.bestMargin !== null &&
    input.bestMargin < settings.marginFloor
  ) {
    failures.push({ gate: 'margin', reason: GATE_REASONS.margin })
  }
  return { passed: failures.length === 0, failures }
}

export type Grade = 'recommended' | 'caution' | 'not-recommended'
export type DisplayGrade = Grade | 'unverified'

export const GRADE_LABELS: Readonly<Record<DisplayGrade, string>> = {
  recommended: '推荐',
  caution: '谨慎',
  'not-recommended': '不推荐',
  unverified: '未验证',
}

/** 推荐 ≥ 75、谨慎 50–74、不推荐 < 50 */
export function gradeOf(score: number): Grade {
  if (score >= 75) return 'recommended'
  if (score >= 50) return 'caution'
  return 'not-recommended'
}

export interface LeadEvaluation {
  readonly composite: CompositeResult
  readonly gates: GateResult
  /** 计算出的等级（保存）；综合分为空且门槛通过时为 null */
  readonly grade: Grade | null
  /** 界面显示的等级：冷启动显示“未验证”；硬门槛不通过始终显示“不推荐” */
  readonly displayGrade: DisplayGrade | null
  readonly settingsVersion: number
}

export function evaluateLead(
  dimensions: readonly DimensionResult[],
  readiness: Readiness,
  settings: ScoringSettings = DEFAULT_SCORING_SETTINGS,
): LeadEvaluation {
  const composite = compositeScore(dimensions, settings)
  const gates = evaluateGates(gateInputFrom(dimensions), settings)
  const grade: Grade | null = !gates.passed
    ? 'not-recommended'
    : composite.score === null
      ? null
      : gradeOf(composite.score)
  // 硬门槛是规则判断，不依赖回测样本，所以冷启动下仍直接显示“不推荐”
  const displayGrade: DisplayGrade | null =
    grade === null ? null : gates.passed && readiness === 'cold-start' ? 'unverified' : grade
  return { composite, gates, grade, displayGrade, settingsVersion: settings.version }
}

/**
 * 信号类型（准备度按 平台 × 方向 × 信号类型 分组）= 对综合分贡献最高的维度：
 * 贡献 = 权重 × 分数'（反向维度取 100 − 分数）。并列时按 DIMENSIONS 顺序取先出现的；
 * 没有分数或权重为 0 的维度不参与；全部不可算时为 null。
 */
export function dominantDimension(
  dimensions: readonly Pick<DimensionResult, 'dimension' | 'score'>[],
  settings: ScoringSettings = DEFAULT_SCORING_SETTINGS,
): DimensionId | null {
  const byId = new Map(dimensions.map((d) => [d.dimension, d.score]))
  const reversed = new Set(settings.reversed)
  let best: DimensionId | null = null
  let bestValue = -1
  for (const id of DIMENSIONS) {
    const score = byId.get(id)
    const weight = settings.weights[id]
    if (score === null || score === undefined || !(weight > 0)) continue
    const value = weight * (reversed.has(id) ? 100 - score : score)
    if (value > bestValue) {
      best = id
      bestValue = value
    }
  }
  return best
}
