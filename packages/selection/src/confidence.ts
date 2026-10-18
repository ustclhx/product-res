import { hoursBetween } from './dates.ts'
import { type HistoryHitRate, historyHitRateValue } from './readiness.ts'
import { clamp, coefficientOfVariation, mean } from './scales.ts'
import { INTERNAL_SOURCES } from './signals.ts'
import type { DimensionId, DimensionResult, Readiness } from './types.ts'

/**
 * 单条线索的置信度（design D6，docs/plan/selection-workbench.md 第 11.1 节）。
 * M2 可算 8 项；成本确定性（M3）与历史命中率（M5）在调用方传入对应输入时加入。
 * 每项 0–1，不可算时为 null 且不计入平均。
 */

export const CONFIDENCE_ITEMS = [
  'coverage',
  'freshness',
  'signal-consistency',
  'source-consistency',
  'merge',
  'season-stability',
  'time-slack',
  'competition-stability',
  'cost-certainty',
  'history-hit-rate',
] as const
export type ConfidenceItemId = (typeof CONFIDENCE_ITEMS)[number]

export const CONFIDENCE_LABELS: Readonly<Record<ConfidenceItemId, string>> = {
  coverage: '数据覆盖',
  freshness: '数据新鲜度',
  'signal-consistency': '信号一致性',
  'source-consistency': '来源一致性',
  merge: '归并可信度',
  'season-stability': '季节规律稳定性',
  'time-slack': '时间余量',
  'competition-stability': '竞争稳定性',
  'cost-certainty': '成本确定性',
  'history-hit-rate': '历史命中率',
}

/** 置信度常数 */
export const CONFIDENCE_SCALES = {
  coverage: { fullSnapshotDays: 30, fullMembers: 5, fullSellers: 3 },
  /** 最近一次获取 ≤ 24 小时为 1，≥ 168 小时为 0 */
  freshnessHours: { fresh: 24, stale: 168 },
  /** 信号一致性统计的独立信号与“为正”的阈值 */
  signalDimensions: ['market-demand', 'growth-season', 'peer-spread'] as readonly DimensionId[],
  positiveScore: 50,
  /** 来源间变异系数达到此值视为完全不一致 */
  sourceCvMax: 0.5,
  /** 只有单一来源时来源一致性的取值 */
  unverifiedValue: 0.5,
  /** 竞争稳定性：价格变异系数与卖家数增速的上限 */
  priceCvMax: 0.3,
  sellerGrowthMax: 0.5,
  /** 历史命中率为空（无样本或样本不足）时总置信度乘以此系数：为空不按 0 计，但要降低总置信度 */
  missingHistoryFactor: 0.9,
  /** 总置信度分档 */
  levels: { high: 0.7, medium: 0.4 },
  /** 高分低置信的综合分线 */
  attentionScore: 75,
} as const

export interface ConfidenceItem {
  readonly id: ConfidenceItemId
  readonly value: number | null
  readonly note: string
}

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export const CONFIDENCE_LEVEL_LABELS: Readonly<Record<ConfidenceLevel, string>> = {
  high: '高',
  medium: '中',
  low: '低',
}

export interface ConfidenceInput {
  /** 计算时刻 ISO 8601 */
  readonly now: string
  readonly dimensions: readonly DimensionResult[]
  readonly coverage: {
    /** 簇内有快照的天数 */
    readonly snapshotDays: number
    readonly memberCount: number
    /** 覆盖的店铺（卖家）数 */
    readonly sellerCount: number
  }
  /** 簇成员的归并置信度 */
  readonly memberConfidences: readonly number[]
  /** 最近一次成功同步时刻；省略时取维度输入中最新的 fetchedAt */
  readonly lastSyncedAt?: string | undefined
  readonly readiness?: Readiness | undefined
  /** 同平台 × 方向 × 信号类型的已打标签样本统计；省略时不计算历史命中率项（M2 行为） */
  readonly historyHitRate?: HistoryHitRate | undefined
  /**
   * 成本确定性（packages/costing 的 certainty，0–1）；null 表示尚未核算（该项为空），
   * 省略时不计算该项（M2 行为）
   */
  readonly costCertainty?: number | null | undefined
}

export interface ConfidenceResult {
  readonly items: readonly ConfidenceItem[]
  /** 可算项的平均（0–1）；没有任何可算项时为 0 */
  readonly value: number
  readonly level: ConfidenceLevel
  /** 只有单一来源的指标（界面标“未交叉验证”） */
  readonly unverifiedMetrics: readonly string[]
}

const internal = new Set<string>(Object.values(INTERNAL_SOURCES))
const ratio = (value: number, full: number) => clamp(value / full, 0, 1)
const round = (value: number) => Math.round(value * 1000) / 1000

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const byId = new Map(input.dimensions.map((d) => [d.dimension, d]))
  const external = input.dimensions
    .flatMap((d) => d.inputs)
    .filter((r) => !internal.has(r.sourceId))
  const s = CONFIDENCE_SCALES
  const items: ConfidenceItem[] = []

  // ① 数据覆盖
  const demand = byId.get('market-demand')
  const salesAvailable = demand?.detail?.salesAvailable === true
  const { snapshotDays, memberCount, sellerCount } = input.coverage
  items.push({
    id: 'coverage',
    value: round(
      mean([
        ratio(snapshotDays, s.coverage.fullSnapshotDays),
        ratio(memberCount, s.coverage.fullMembers),
        ratio(sellerCount, s.coverage.fullSellers),
        salesAvailable ? 1 : 0,
      ]) as number,
    ),
    note: `快照 ${snapshotDays} 天，${memberCount} 个成员，${sellerCount} 家店铺${salesAvailable ? '' : '，无销量字段'}`,
  })

  // ② 数据新鲜度
  const lastSynced =
    input.lastSyncedAt ??
    external.reduce<string | undefined>(
      (latest, r) => (latest === undefined || r.fetchedAt > latest ? r.fetchedAt : latest),
      undefined,
    )
  if (lastSynced === undefined) {
    items.push({ id: 'freshness', value: null, note: '没有外部数据' })
  } else {
    const hours = Math.max(0, hoursBetween(lastSynced, input.now))
    const { fresh, stale } = s.freshnessHours
    items.push({
      id: 'freshness',
      value: round(clamp(1 - (hours - fresh) / (stale - fresh), 0, 1)),
      note: `最近获取距今 ${Math.round(hours)} 小时`,
    })
  }

  // ③ 信号一致性：需求、季节、扩散中同时为正的个数
  const positives = s.signalDimensions.filter((id) => {
    const score = byId.get(id)?.score
    return score !== null && score !== undefined && score >= s.positiveScore
  }).length
  items.push({
    id: 'signal-consistency',
    value: round(positives / s.signalDimensions.length),
    note: `${positives}/${s.signalDimensions.length} 个独立信号为正`,
  })

  // ④ 来源一致性：同指标同实体同日多来源的离散度；只有单一来源的指标标“未交叉验证”
  const sourcesByMetric = new Map<string, Set<string>>()
  const groups = new Map<string, Map<string, number>>()
  for (const r of external) {
    sourcesByMetric.set(r.metric, (sourcesByMetric.get(r.metric) ?? new Set()).add(r.sourceId))
    const key = `${r.metric}|${r.entityId ?? ''}|${r.observedOn}`
    const group = groups.get(key) ?? new Map<string, number>()
    group.set(r.sourceId, r.value)
    groups.set(key, group)
  }
  const unverifiedMetrics = [...sourcesByMetric]
    .filter(([, sources]) => sources.size < 2)
    .map(([metric]) => metric)
    .sort()
  const agreements: number[] = []
  for (const group of groups.values()) {
    if (group.size < 2) continue
    const cv = coefficientOfVariation([...group.values()])
    agreements.push(cv === null ? 1 : 1 - clamp(cv / s.sourceCvMax, 0, 1))
  }
  const agreement = mean(agreements)
  items.push(
    agreement === null
      ? {
          id: 'source-consistency',
          value: sourcesByMetric.size === 0 ? null : s.unverifiedValue,
          note: '未交叉验证',
        }
      : {
          id: 'source-consistency',
          value: round(agreement),
          note:
            unverifiedMetrics.length > 0
              ? `${agreements.length} 组多来源对照；未交叉验证：${unverifiedMetrics.join('、')}`
              : `${agreements.length} 组多来源对照`,
        },
  )

  // ⑤ 归并可信度
  const merge = mean(input.memberConfidences)
  items.push({
    id: 'merge',
    value: merge === null ? null : round(clamp(merge, 0, 1)),
    note: merge === null ? '没有成员' : `成员平均归并置信度 ${round(merge)}`,
  })

  // ⑥ 季节规律稳定性
  const stability = byId.get('growth-season')?.detail?.seasonStability
  items.push({
    id: 'season-stability',
    value: typeof stability === 'number' ? round(stability) : null,
    note: typeof stability === 'number' ? `年际相关 ${round(stability)}` : '历年数据不足',
  })

  // ⑦ 时间余量：剩余天数 ÷ 所需提前期
  const supply = byId.get('supply-timing')?.detail
  if (typeof supply?.slackDays === 'number' && typeof supply.leadDays === 'number') {
    const value = supply.leadDays > 0 ? clamp(supply.slackDays / supply.leadDays, 0, 1) : 1
    items.push({
      id: 'time-slack',
      // 只用默认提前期时余量本身不可靠，减半
      value: round(supply.usedDefaultLeadTime === true ? value / 2 : value),
      note: `余量 ${supply.slackDays} 天 / 提前期 ${supply.leadDays} 天${supply.usedDefaultLeadTime === true ? '（默认提前期）' : ''}`,
    })
  } else {
    items.push({ id: 'time-slack', value: null, note: '未关联销售节点' })
  }

  // ⑧ 竞争稳定性：价格波动率与卖家数增速
  const comp = byId.get('competition')?.detail
  const stabilityParts: number[] = []
  if (typeof comp?.priceCv === 'number') {
    stabilityParts.push(1 - clamp(comp.priceCv / s.priceCvMax, 0, 1))
  }
  if (typeof comp?.sellerGrowth === 'number') {
    stabilityParts.push(1 - clamp(Math.abs(comp.sellerGrowth) / s.sellerGrowthMax, 0, 1))
  }
  const compStability = mean(stabilityParts)
  items.push({
    id: 'competition-stability',
    value: compStability === null ? null : round(compStability),
    note: compStability === null ? '没有价格或卖家数历史' : '按价格波动率与卖家数增速',
  })

  // ⑨ 成本确定性：报价可信度、物流字段齐全度、FBA 费来源
  if (input.costCertainty !== undefined) {
    items.push(
      input.costCertainty === null
        ? { id: 'cost-certainty', value: null, note: '未核算' }
        : {
            id: 'cost-certainty',
            value: round(clamp(input.costCertainty, 0, 1)),
            note: '按核算组合的报价可信度、物流字段与 FBA 费来源',
          },
    )
  }

  // ⑩ 历史命中率（Wilson 下界）
  let factor = 1
  if (input.historyHitRate !== undefined) {
    const history = historyHitRateValue(input.historyHitRate)
    items.push({ id: 'history-hit-rate', ...history })
    if (history.value === null) factor = s.missingHistoryFactor
  }

  const value = round(
    (mean(items.map((i) => i.value).filter((v): v is number => v !== null)) ?? 0) * factor,
  )
  let level = confidenceLevel(value)
  // 观察期置信度上限为“中”（第 11.2 节）
  if (input.readiness === 'observation' && level === 'high') level = 'medium'
  return { items, value, level, unverifiedMetrics }
}

export function confidenceLevel(value: number): ConfidenceLevel {
  if (value >= CONFIDENCE_SCALES.levels.high) return 'high'
  if (value >= CONFIDENCE_SCALES.levels.medium) return 'medium'
  return 'low'
}

/** 排序键 = 综合分 × 置信度；无综合分的排在最后 */
export function rankKey(composite: number | null, confidence: number): number {
  return composite === null ? -1 : Math.round(composite * confidence * 100) / 100
}

/** 高分低置信：界面标“值得关注但证据不足” */
export const ATTENTION_LABEL = '值得关注但证据不足'

export function needsAttention(composite: number | null, level: ConfidenceLevel): boolean {
  return composite !== null && composite >= CONFIDENCE_SCALES.attentionScore && level === 'low'
}
