import type { Marketplace } from '@product-res/datasources'
import {
  type Database,
  direction,
  recommendation,
  recommendationLabel,
  type SelectionDimension,
  scoped,
  weightSuggestion,
} from '@product-res/db'
import {
  addDays,
  DEFAULT_READINESS_THRESHOLDS,
  DEFAULT_SAMPLE_WEIGHTS,
  type LabelOutcome,
  type Platform,
  platformOf,
  type Readiness,
  type SampleKind,
  wilsonLowerBound,
} from '@product-res/selection'
import { desc, gte } from 'drizzle-orm'
import { latestReadiness, localDay, SELECTION_TIME_ZONE } from './pipeline.ts'
import { listReplays, type ReplayJobView } from './replay.ts'
import { dueLabels, PRIMARY_WINDOW } from './validation.ts'

/**
 * 算法验证页（design D6，tasks 4.1）的只读汇总。页面只调用 getValidationOverview，
 * 所有数值来自已落库的推荐、标签、准备度统计、权重建议与回放任务，不生成示例数据。
 */

export type SampleCounts = Readonly<Record<SampleKind, number>>

/** 准备度矩阵的一格：站点 × 方向 × 信号类型的最新统计 */
export interface ReadinessCell {
  readonly marketplace: string
  readonly platform: Platform | null
  readonly directionId: string
  readonly directionName: string
  readonly signalType: SelectionDimension
  /** 统计计算日 YYYY-MM-DD */
  readonly computedOn: string
  readonly level: Readiness
  /** 各类型已打 T+30 标签的条数（不含数据不足） */
  readonly samples: SampleCounts
  readonly hitCount: number
  /** 加权有效样本（影子 1.0、回放 0.5、导入 0.3） */
  readonly effectiveSamples: number
  readonly wilsonLower: number | null
  /** 同方向随机新品的命中率；样本不足时为 null */
  readonly baseline: number | null
  /** 距进入观察期还差的有效样本（已达到为 0） */
  readonly samplesToObservation: number
}

/** 按打标签月份的 T+30 命中率（数据不足不进分母） */
export interface MonthlyHitRate {
  /** YYYY-MM */
  readonly month: string
  readonly effectiveSamples: number
  /** 加权命中率；该月没有样本时为 null */
  readonly hitRate: number | null
  /** 各类型未加权的 命中 / 有效标签 条数 */
  readonly byKind: Readonly<Record<SampleKind, { readonly hits: number; readonly labeled: number }>>
}

export interface SampleComposition {
  /** 已冻结的推荐条数 */
  readonly recommendations: SampleCounts
  /** 已打 T+30 标签（命中或未命中）的条数 */
  readonly labeled: SampleCounts
  /** T+30 数据不足的条数 */
  readonly insufficient: SampleCounts
}

export interface PendingLabels {
  /** 已到期未打标签的 推荐 × 窗口 数 */
  readonly total: number
  readonly byWindow: Readonly<Record<'14' | '30' | '60', number>>
}

/** 每个信号类型（主导维度）跨站点、方向的回测命中率，供数据中心评分维度旁显示 */
export interface SignalTypeHitRate {
  readonly signalType: SelectionDimension
  readonly effectiveSamples: number
  readonly hitRate: number | null
  readonly wilsonLower: number | null
  /** 其中历史回放样本的条数 */
  readonly replaySamples: number
}

export interface SuggestionView {
  readonly id: string
  readonly status: 'proposed' | 'accepted' | 'dismissed'
  readonly fittedAt: Date
  readonly sampleCount: number
  readonly suggestedWeights: Readonly<Record<SelectionDimension, number>>
  readonly currentWeights: Readonly<Record<SelectionDimension, number>>
  /** 拟合时的评分设置版本 */
  readonly baseVersion: number | null
  /** 采用后生成的版本 */
  readonly acceptedVersion: number | null
  /** 交叉验证（折外）与当前权重在同一批样本上的指标 */
  readonly crossValidation: { readonly auc: number | null; readonly lift: number | null } | null
  readonly current: { readonly auc: number | null; readonly lift: number | null } | null
  readonly resolvedAt: Date | null
}

export interface ColdStartInfo {
  /** 全部组合都处于冷启动（含尚无任何统计） */
  readonly allColdStart: boolean
  /** 最接近的组合距观察期还差的有效样本 */
  readonly samplesNeeded: number
  /** 近 14 天每个组合平均每天新增的影子推荐 */
  readonly dailyShadowRate: number
  /** 预计天数 = 还差样本 ÷ 日增量 + 30 天等待 T+30 到期；无新增时为 null */
  readonly estimatedDays: number | null
}

export interface ValidationOverview {
  readonly asOf: string
  readonly readiness: readonly ReadinessCell[]
  /** 最近 12 个月，从早到晚 */
  readonly monthly: readonly MonthlyHitRate[]
  readonly composition: SampleComposition
  readonly pendingLabels: PendingLabels
  readonly bySignalType: readonly SignalTypeHitRate[]
  /** 最新一条权重建议（任意状态）；没有时为 null */
  readonly latestSuggestion: SuggestionView | null
  /** 最近的回放任务 */
  readonly replays: readonly ReplayJobView[]
  readonly coldStart: ColdStartInfo
}

const KINDS: readonly SampleKind[] = ['shadow', 'replay', 'import']
const zero = (): Record<SampleKind, number> => ({ shadow: 0, replay: 0, import: 0 })
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits

function lastMonths(asOf: string, count: number): string[] {
  const year = Number(asOf.slice(0, 4))
  const month = Number(asOf.slice(5, 7)) - 1
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(year, month - (count - 1 - i), 1)).toISOString().slice(0, 7),
  )
}

const metric = (value: unknown) => {
  const m = value as { auc?: unknown; lift?: unknown } | undefined
  if (!m || typeof m !== 'object') return null
  return {
    auc: typeof m.auc === 'number' ? m.auc : null,
    lift: typeof m.lift === 'number' ? m.lift : null,
  }
}

export async function getValidationOverview(
  db: Database,
  workspaceId: string,
  options: { readonly now?: Date | undefined } = {},
): Promise<ValidationOverview> {
  const now = options.now ?? new Date()
  const asOf = localDay(now, SELECTION_TIME_ZONE)
  const s = scoped(db, workspaceId)
  const [stats, directions, recs, labels, [suggestion], replays, due] = await Promise.all([
    latestReadiness(db, workspaceId),
    s.select(direction, { fields: { id: direction.id, name: direction.name } }),
    s.select(recommendation, {
      fields: {
        id: recommendation.id,
        signalType: recommendation.signalType,
        sampleKind: recommendation.sampleKind,
        frozenOn: recommendation.frozenOn,
      },
    }),
    s.select(recommendationLabel, {
      where: gte(recommendationLabel.windowDays, PRIMARY_WINDOW),
      fields: {
        recommendationId: recommendationLabel.recommendationId,
        windowDays: recommendationLabel.windowDays,
        outcome: recommendationLabel.outcome,
        labeledAt: recommendationLabel.labeledAt,
      },
    }),
    s.select(weightSuggestion).orderBy(desc(weightSuggestion.fittedAt)).limit(1),
    listReplays(db, workspaceId),
    dueLabels(db, workspaceId, asOf),
  ])
  const names = new Map(directions.map((d) => [d.id, d.name]))
  const observation = DEFAULT_READINESS_THRESHOLDS.observation

  const readiness: ReadinessCell[] = [...stats.values()]
    .filter((r) => names.has(r.directionId))
    .map((r) => ({
      marketplace: r.marketplace,
      platform: platformOf(r.marketplace as Marketplace),
      directionId: r.directionId,
      directionName: names.get(r.directionId) as string,
      signalType: r.signalType,
      computedOn: r.computedOn,
      level: r.level,
      samples: { shadow: r.shadowCount, replay: r.replayCount, import: r.importCount },
      hitCount: r.hitCount,
      effectiveSamples: r.effectiveSamples,
      wilsonLower: r.wilsonLower,
      baseline: r.baseline,
      samplesToObservation: Math.max(0, round(observation - r.effectiveSamples, 2)),
    }))
    .sort(
      (a, b) =>
        a.marketplace.localeCompare(b.marketplace) ||
        a.directionName.localeCompare(b.directionName) ||
        a.signalType.localeCompare(b.signalType),
    )

  // T+30 标签按月与按信号类型汇总
  const recOf = new Map(recs.map((r) => [r.id, r]))
  const months = lastMonths(asOf, 12)
  const monthly = new Map(
    months.map((m) => [
      m,
      {
        n: 0,
        hits: 0,
        byKind: Object.fromEntries(KINDS.map((k) => [k, { hits: 0, labeled: 0 }])) as Record<
          SampleKind,
          { hits: number; labeled: number }
        >,
      },
    ]),
  )
  const labeled = zero()
  const insufficient = zero()
  const bySignal = new Map<SelectionDimension, { n: number; hits: number; replay: number }>()
  for (const label of labels) {
    if (label.windowDays !== PRIMARY_WINDOW) continue
    const rec = recOf.get(label.recommendationId)
    if (!rec) continue
    const kind = rec.sampleKind as SampleKind
    const outcome = label.outcome as LabelOutcome
    if (outcome === 'insufficient') {
      insufficient[kind] += 1
      continue
    }
    labeled[kind] += 1
    const w = DEFAULT_SAMPLE_WEIGHTS[kind]
    const hit = outcome === 'hit'
    const bucket = monthly.get(localDay(label.labeledAt, SELECTION_TIME_ZONE).slice(0, 7))
    if (bucket) {
      bucket.n += w
      if (hit) bucket.hits += w
      bucket.byKind[kind].labeled += 1
      if (hit) bucket.byKind[kind].hits += 1
    }
    const sig = bySignal.get(rec.signalType) ?? { n: 0, hits: 0, replay: 0 }
    sig.n += w
    if (hit) sig.hits += w
    if (kind === 'replay') sig.replay += 1
    bySignal.set(rec.signalType, sig)
  }
  const recommendations = zero()
  for (const rec of recs) recommendations[rec.sampleKind as SampleKind] += 1

  const byWindow = { '14': 0, '30': 0, '60': 0 }
  for (const d of due) for (const w of d.windows) byWindow[String(w) as '14' | '30' | '60'] += 1

  // 冷启动说明：最接近观察期的组合还差多少样本，按近 14 天影子推荐的新增速度估算天数
  const groups = Math.max(1, readiness.length)
  const since = addDays(asOf, -14)
  const recentShadow = recs.filter((r) => r.sampleKind === 'shadow' && r.frozenOn > since).length
  const dailyShadowRate = round(recentShadow / 14 / groups, 2)
  const best = readiness.reduce((max, r) => Math.max(max, r.effectiveSamples), 0)
  const samplesNeeded = Math.max(0, round(observation - best, 2))

  return {
    asOf,
    readiness,
    monthly: months.map((month) => {
      const b = monthly.get(month) as NonNullable<ReturnType<typeof monthly.get>>
      return {
        month,
        effectiveSamples: round(b.n),
        hitRate: b.n > 0 ? round(b.hits / b.n) : null,
        byKind: b.byKind,
      }
    }),
    composition: { recommendations, labeled, insufficient },
    pendingLabels: {
      total: byWindow['14'] + byWindow['30'] + byWindow['60'],
      byWindow,
    },
    bySignalType: [...bySignal]
      .map(([signalType, v]) => {
        const lower = wilsonLowerBound(v.hits, v.n)
        return {
          signalType,
          effectiveSamples: round(v.n),
          hitRate: v.n > 0 ? round(v.hits / v.n) : null,
          wilsonLower: lower === null ? null : round(lower),
          replaySamples: v.replay,
        }
      })
      .sort((a, b) => a.signalType.localeCompare(b.signalType)),
    latestSuggestion: suggestion
      ? {
          id: suggestion.id,
          status: suggestion.status,
          fittedAt: suggestion.fittedAt,
          sampleCount: suggestion.sampleCount,
          suggestedWeights: suggestion.suggestedWeights,
          currentWeights: suggestion.currentWeights,
          baseVersion:
            typeof suggestion.metrics.baseVersion === 'number'
              ? suggestion.metrics.baseVersion
              : null,
          acceptedVersion:
            typeof suggestion.metrics.acceptedVersion === 'number'
              ? suggestion.metrics.acceptedVersion
              : null,
          crossValidation: metric(suggestion.metrics.crossValidation),
          current: metric(suggestion.metrics.current),
          resolvedAt: suggestion.resolvedAt,
        }
      : null,
    replays,
    coldStart: {
      allColdStart: readiness.every((r) => r.level === 'cold-start'),
      samplesNeeded,
      dailyShadowRate,
      estimatedDays:
        samplesNeeded === 0
          ? 0
          : dailyShadowRate > 0
            ? Math.ceil(samplesNeeded / dailyShadowRate) + PRIMARY_WINDOW
            : null,
    },
  }
}
