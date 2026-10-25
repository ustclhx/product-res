import type { Marketplace } from '@product-res/datasources'
import {
  cluster,
  clusterMember,
  type Database,
  direction,
  type Recommendation,
  readinessStat,
  recommendation,
  recommendationLabel,
  type SelectionDimension,
  scoped,
  transferringWorkspaceIds,
  weightSuggestion,
} from '@product-res/db'
import { type MetricPoint, productsByIds, readMetricSeries } from '@product-res/marketdata'
import {
  addDays,
  DEFAULT_HIT_CRITERIA,
  diffDays,
  dueWindows,
  evaluateReadiness,
  type HitCriteria,
  LABEL_WINDOWS,
  type LabeledSample,
  type LabelObservation,
  type LabelResult,
  type LabelWindow,
  labelRecommendation,
  platformOf,
  type Readiness,
  type SampleKind,
} from '@product-res/selection'
import { log } from '@product-res/shared/log'
import { and, eq, inArray, lte, type SQL, sql } from 'drizzle-orm'
import { localDay, SELECTION_TIME_ZONE, weekStart } from './pipeline.ts'
import { currentScoringSetting } from './settings.ts'

/**
 * 影子验证（openspec/changes/add-shadow-validation tasks 2.2）：
 * - selection-label-v1：到期（T+14 / 30 / 60）的推荐按命中标准打标签，推荐 × 窗口唯一，重复运行幂等
 * - 每周重算准备度：平台 × 方向 × 信号类型 的样本、Wilson 下界与基线（同方向随机新品的命中率）
 */

/** 准备度、拟合与命中率曲线使用的主窗口（命中标准按 T+30 定义） */
export const PRIMARY_WINDOW: LabelWindow = 30

/** eBay 累计已售两次快照相隔超过此天数时不再均摊为日增量（间隔过长的差分不代表窗口内的销量分布） */
const MAX_SNAPSHOT_GAP_DAYS = 7
/** 读取冻结日前的基准（基准价、累计已售差分起点）的回看天数 */
const BASE_LOOKBACK_DAYS = 14
/** 基线：每个方向每次最多抽取的新品数、新品的上架窗口与最少有效样本 */
export const BASELINE = { sampleSize: 50, newWithinDays: 30, minLabeled: 5 } as const

export interface LabelOptions {
  readonly now: Date
  /** 打标签日；默认按新加坡时间取 now 的日期 */
  readonly today?: string | undefined
  /** 命中标准 X、Y 与高峰误差；默认 30 件、15%、2 周 */
  readonly criteria?: HitCriteria | undefined
}

/** 簇的打标签序列：日销量、竞品中位价，以及所用指标与来源 */
export interface ClusterLabelSeries {
  readonly dailySales: LabelObservation[]
  readonly medianPrices: LabelObservation[]
  /** 销量所用指标：eBay sold_quantity_total 差分；Amazon sold_quantity_daily 或 sales_estimate_monthly ÷ 30 */
  readonly salesMetrics: string[]
  readonly salesSources: string[]
  readonly priceSources: string[]
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * 读取一组商品在 [from, to] 的打标签序列。簇的日销量 = 当天有观测的成员之和；
 * 同一天没有任何成员观测时视为缺失（不按 0 计）。
 */
export async function clusterLabelSeries(
  db: Database,
  input: {
    readonly marketplace: string
    readonly productIds: readonly string[]
    readonly from: string
    readonly to: string
  },
): Promise<ClusterLabelSeries> {
  const platform = platformOf(input.marketplace as Marketplace)
  const metrics =
    platform === 'ebay'
      ? ['sold_quantity_total', 'price']
      : ['sold_quantity_daily', 'sales_estimate_monthly', 'price']
  const series = await readMetricSeries(db, {
    entityType: 'product',
    entityIds: input.productIds,
    metrics,
    marketplace: input.marketplace as Marketplace,
    from: input.from,
    to: input.to,
  })
  const sales = new Map<string, { value: number; sourceId: string }>()
  const salesMetrics = new Set<string>()
  const salesSources = new Set<string>()
  const add = (on: string, value: number, sourceId: string, metric: string) => {
    const prev = sales.get(on)
    sales.set(on, { value: (prev?.value ?? 0) + value, sourceId: prev?.sourceId ?? sourceId })
    salesMetrics.add(metric)
    salesSources.add(sourceId)
  }
  const prices = new Map<string, { values: number[]; sourceId: string }>()
  const priceSources = new Set<string>()
  for (const id of input.productIds) {
    const byMetric = series.get(id)
    if (!byMetric) continue
    if (platform === 'ebay') {
      // 累计已售差分：相邻两次快照的增量均摊到区间内每一天；累计值回退（刊登重建）的区间跳过
      const totals = byMetric.get('sold_quantity_total') ?? []
      for (let i = 1; i < totals.length; i += 1) {
        const prev = totals[i - 1] as MetricPoint
        const cur = totals[i] as MetricPoint
        const gap = diffDays(prev.observedOn, cur.observedOn)
        const inc = cur.primary.value - prev.primary.value
        if (gap <= 0 || gap > MAX_SNAPSHOT_GAP_DAYS || inc < 0) continue
        for (let d = 1; d <= gap; d += 1)
          add(addDays(prev.observedOn, d), inc / gap, cur.primary.sourceId, 'sold_quantity_total')
      }
    } else {
      // Amazon：有日销量用日销量，否则月销量估算主值 ÷ 30
      const daily = new Map(
        (byMetric.get('sold_quantity_daily') ?? []).map((p) => [p.observedOn, p]),
      )
      const monthly = new Map(
        (byMetric.get('sales_estimate_monthly') ?? []).map((p) => [p.observedOn, p]),
      )
      for (const on of new Set([...daily.keys(), ...monthly.keys()])) {
        const d = daily.get(on)
        if (d) add(on, Math.max(0, d.primary.value), d.primary.sourceId, 'sold_quantity_daily')
        else {
          const m = monthly.get(on) as MetricPoint
          add(on, Math.max(0, m.primary.value) / 30, m.primary.sourceId, 'sales_estimate_monthly')
        }
      }
    }
    for (const point of byMetric.get('price') ?? []) {
      if (!(point.primary.value > 0)) continue
      const entry = prices.get(point.observedOn) ?? {
        values: [],
        sourceId: point.primary.sourceId,
      }
      entry.values.push(point.primary.value)
      prices.set(point.observedOn, entry)
      priceSources.add(point.primary.sourceId)
    }
  }
  return {
    dailySales: [...sales]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([observedOn, v]) => ({ observedOn, value: v.value, sourceId: v.sourceId })),
    medianPrices: [...prices]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([observedOn, v]) => ({
        observedOn,
        value: median(v.values),
        sourceId: v.sourceId,
      })),
    salesMetrics: [...salesMetrics].sort(),
    salesSources: [...salesSources].sort(),
    priceSources: [...priceSources].sort(),
  }
}

/** 窗口内周销量最高的一周（周一）；没有销量观测时为 null */
function actualPeakWeek(daily: readonly LabelObservation[], from: string, to: string) {
  const weeks = new Map<string, number>()
  for (const p of daily) {
    if (p.value === null || p.observedOn <= from || p.observedOn > to) continue
    const week = weekStart(p.observedOn)
    weeks.set(week, (weeks.get(week) ?? 0) + p.value)
  }
  let best: string | null = null
  let bestValue = Number.NEGATIVE_INFINITY
  for (const [week, value] of [...weeks].sort(([a], [b]) => a.localeCompare(b))) {
    if (value > bestValue) {
      best = week
      bestValue = value
    }
  }
  return best
}

export interface LabelTarget {
  readonly marketplace: string
  readonly productIds: readonly string[]
  readonly frozenOn: string
  readonly window: LabelWindow
  readonly signalType?: string | undefined
  readonly predictedPeakWeek?: string | null | undefined
}

/** 对一个推荐（或基线新品）的一个窗口计算标签，不写库 */
export async function computeLabel(
  db: Database,
  target: LabelTarget,
  criteria: HitCriteria = DEFAULT_HIT_CRITERIA,
): Promise<{ result: LabelResult; series: ClusterLabelSeries }> {
  const end = addDays(target.frozenOn, target.window)
  const series = await clusterLabelSeries(db, {
    marketplace: target.marketplace,
    productIds: target.productIds,
    from: addDays(target.frozenOn, -BASE_LOOKBACK_DAYS),
    to: end,
  })
  // 季节类只在预测高峰周落在本窗口内时比较高峰误差；高峰在窗口之后的短窗口按非季节类判定
  const predicted = target.predictedPeakWeek ?? null
  const seasonal =
    target.signalType === 'growth-season' &&
    predicted !== null &&
    predicted > target.frozenOn &&
    predicted <= end
  const result = labelRecommendation(
    {
      frozenOn: target.frozenOn,
      window: target.window,
      dailySales: series.dailySales,
      medianPrices: series.medianPrices,
      ...(seasonal
        ? {
            season: {
              predictedPeakWeek: predicted,
              actualPeakWeek: actualPeakWeek(series.dailySales, target.frozenOn, end),
            },
          }
        : {}),
    },
    criteria,
  )
  return { result, series }
}

const clampRatio = (value: number | null) =>
  value === null ? null : Math.min(9.99999, Math.max(-9.99999, value))

const membersOf = (rec: Recommendation): string[] => {
  const members = (rec.inputs as { members?: unknown }).members
  return Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string') : []
}

/** 冻结快照没有成员列表时（旧数据）退回簇的当前成员 */
async function recommendationMembers(db: Database, rec: Recommendation): Promise<string[]> {
  const frozen = membersOf(rec)
  if (frozen.length > 0) return frozen
  const rows = await scoped(db, rec.workspaceId).select(clusterMember, {
    where: eq(clusterMember.clusterId, rec.clusterId),
    fields: { productId: clusterMember.productId },
  })
  return rows.map((r) => r.productId)
}

/** 给一个推荐的一个窗口打标签并写入；推荐 × 窗口唯一，已有标签不覆盖。返回是否新写入 */
export async function labelAndStore(
  db: Database,
  rec: Recommendation,
  window: LabelWindow,
  criteria: HitCriteria = DEFAULT_HIT_CRITERIA,
  now: Date = new Date(),
): Promise<boolean> {
  const { result, series } = await computeLabel(
    db,
    {
      marketplace: rec.marketplace,
      productIds: await recommendationMembers(db, rec),
      frozenOn: rec.frozenOn,
      window,
      signalType: rec.signalType,
      predictedPeakWeek: (rec.inputs as { predictedPeakWeek?: string | null }).predictedPeakWeek,
    },
    criteria,
  )
  const inserted = await scoped(db, rec.workspaceId)
    .insert(recommendationLabel, {
      recommendationId: rec.id,
      windowDays: window,
      outcome: result.outcome,
      salesDelta: result.salesIncrement,
      priceDropRate: clampRatio(result.priceDrop),
      peakWeekError: result.peakErrorWeeks,
      sources: {
        salesMetrics: series.salesMetrics,
        salesSources: series.salesSources,
        priceSources: series.priceSources,
        coverage: result.coverage,
        reason: result.reason,
        criteria: { ...criteria },
      },
      labeledAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: recommendationLabel.id })
  return inserted.length > 0
}

/** 本空间到期未打标签的推荐 × 窗口 */
export async function dueLabels(
  db: Database,
  workspaceId: string,
  today: string,
): Promise<{ rec: Recommendation; windows: LabelWindow[] }[]> {
  const s = scoped(db, workspaceId)
  const minWindow = Math.min(...LABEL_WINDOWS)
  const recs = await s.select(recommendation, {
    where: and(
      lte(recommendation.frozenOn, addDays(today, -minWindow)),
      sql`(select count(*) from ${recommendationLabel} l where l.recommendation_id = ${recommendation.id}) < ${LABEL_WINDOWS.length}`,
    ) as SQL,
  })
  if (recs.length === 0) return []
  const labels = await s.select(recommendationLabel, {
    where: inArray(
      recommendationLabel.recommendationId,
      recs.map((r) => r.id),
    ),
    fields: {
      recommendationId: recommendationLabel.recommendationId,
      window: recommendationLabel.windowDays,
    },
  })
  const done = new Map<string, LabelWindow[]>()
  for (const l of labels)
    done.set(l.recommendationId, [...(done.get(l.recommendationId) ?? []), l.window as LabelWindow])
  return recs
    .map((rec) => ({ rec, windows: dueWindows(rec.frozenOn, today, done.get(rec.id) ?? []) }))
    .filter((d) => d.windows.length > 0)
}

export interface LabelRunResult {
  readonly workspaceId: string
  readonly labeled: number
  readonly failures: number
}

/** 给一个空间到期的推荐打标签 */
export async function labelDueRecommendations(
  db: Database,
  workspaceId: string,
  options: LabelOptions,
): Promise<LabelRunResult> {
  const today = options.today ?? localDay(options.now, SELECTION_TIME_ZONE)
  let labeled = 0
  let failures = 0
  for (const { rec, windows } of await dueLabels(db, workspaceId, today)) {
    for (const window of windows) {
      try {
        if (await labelAndStore(db, rec, window, options.criteria, options.now)) labeled += 1
      } catch (error) {
        failures += 1
        log.error('selection.label_failed', {
          workspaceId,
          recommendationId: rec.id,
          window,
          error,
        })
      }
    }
  }
  return { workspaceId, labeled, failures }
}

/** selection-label-v1 入口：逐个有推荐的空间打标签 */
export async function runSelectionLabels(
  db: Database,
  options: LabelOptions,
): Promise<LabelRunResult[]> {
  const today = options.today ?? localDay(options.now, SELECTION_TIME_ZONE)
  // 系统任务跨空间列出有到期推荐的空间；之后的读写都经 scoped() 限定
  const workspaces = await db
    .selectDistinct({ workspaceId: recommendation.workspaceId })
    .from(recommendation)
    .where(lte(recommendation.frozenOn, addDays(today, -Math.min(...LABEL_WINDOWS))))
  const out: LabelRunResult[] = []
  const transferring = await transferringWorkspaceIds(db)
  for (const { workspaceId } of workspaces) {
    if (transferring.has(workspaceId)) continue
    try {
      out.push(await labelDueRecommendations(db, workspaceId, { ...options, today }))
    } catch (error) {
      log.error('selection.label_workspace_failed', { workspaceId, error })
    }
  }
  return out
}

// ---------- 准备度 ----------

/** 确定性的伪随机排序键：同一方向、同一计算日抽到的样本可复现 */
function hashKey(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface BaselineResult {
  /** 命中 ÷（命中 + 未命中）；有效样本少于 BASELINE.minLabeled 时为 null */
  readonly hitRate: number | null
  readonly sampled: number
  readonly labeled: number
  readonly hits: number
  /** 基线新品的冻结日（计算日 − 30） */
  readonly frozenOn: string
}

/**
 * 基线（design D3）：同方向、同站点的新品（冻结日前 30 天内上架或首次发现）中随机抽取至多 50 个，
 * 以“计算日 − 30”为冻结日按同一命中标准打 T+30 标签，取命中率。
 * 基线样本只在内存中计算，不写入 recommendation，因此不会计入推荐命中率。
 */
export async function directionBaseline(
  db: Database,
  workspaceId: string,
  input: { readonly directionId: string; readonly marketplace: string; readonly asOf: string },
  criteria: HitCriteria = DEFAULT_HIT_CRITERIA,
): Promise<BaselineResult> {
  const frozenOn = addDays(input.asOf, -PRIMARY_WINDOW)
  const s = scoped(db, workspaceId)
  const rows = await s
    .select(clusterMember, { fields: { productId: clusterMember.productId } })
    .innerJoin(
      cluster,
      and(
        eq(cluster.id, clusterMember.clusterId),
        s.filter(cluster),
        eq(cluster.directionId, input.directionId),
        eq(cluster.marketplace, input.marketplace),
      ),
    )
  const since = addDays(frozenOn, -BASELINE.newWithinDays)
  const candidates = (
    await productsByIds(
      db,
      rows.map((r) => r.productId),
    )
  )
    .filter((p) => {
      const on = (p.listedAt ?? p.firstSeenAt).toISOString().slice(0, 10)
      return on >= since && on <= frozenOn
    })
    .sort(
      (a, b) =>
        hashKey(`${input.directionId}|${input.asOf}|${a.id}`) -
          hashKey(`${input.directionId}|${input.asOf}|${b.id}`) || a.id.localeCompare(b.id),
    )
    .slice(0, BASELINE.sampleSize)
  let labeled = 0
  let hits = 0
  for (const product of candidates) {
    const { result } = await computeLabel(
      db,
      {
        marketplace: input.marketplace,
        productIds: [product.id],
        frozenOn,
        window: PRIMARY_WINDOW,
      },
      criteria,
    )
    if (result.outcome === 'insufficient') continue
    labeled += 1
    if (result.outcome === 'hit') hits += 1
  }
  return {
    hitRate: labeled >= BASELINE.minLabeled ? Math.round((hits / labeled) * 1e5) / 1e5 : null,
    sampled: candidates.length,
    labeled,
    hits,
    frozenOn,
  }
}

export interface ReadinessRunResult {
  readonly workspaceId: string
  readonly groups: number
  readonly levels: Readonly<Record<Readiness, number>>
}

/** 当前评分设置是否来自已采用的拟合建议（“可信”需要权重已校准） */
async function weightsCalibrated(db: Database, workspaceId: string): Promise<boolean> {
  const current = await currentScoringSetting(db, workspaceId)
  const accepted = await scoped(db, workspaceId).select(weightSuggestion, {
    where: eq(weightSuggestion.status, 'accepted'),
    fields: { metrics: weightSuggestion.metrics },
  })
  return accepted.some((a) => a.metrics.acceptedVersion === current.version)
}

/**
 * 重算本空间的准备度（每周一 05:30 SGT）：按 站点 × 方向 × 信号类型 汇总 T+30 标签，
 * 回放与导入样本按较低权重计入有效样本，与同方向基线比较后写入 readiness_stat（同一计算日幂等覆盖）。
 * 没有任何标签的组合也写入一行（冷启动），供页面矩阵显示。
 */
export async function recomputeReadiness(
  db: Database,
  workspaceId: string,
  options: LabelOptions,
): Promise<ReadinessRunResult> {
  const asOf = options.today ?? localDay(options.now, SELECTION_TIME_ZONE)
  const s = scoped(db, workspaceId)
  const recs = await s.select(recommendation, {
    fields: {
      id: recommendation.id,
      marketplace: recommendation.marketplace,
      directionId: recommendation.directionId,
      signalType: recommendation.signalType,
      sampleKind: recommendation.sampleKind,
    },
  })
  const labels = await s.select(recommendationLabel, {
    where: eq(recommendationLabel.windowDays, PRIMARY_WINDOW),
    fields: {
      recommendationId: recommendationLabel.recommendationId,
      outcome: recommendationLabel.outcome,
      labeledAt: recommendationLabel.labeledAt,
    },
  })
  const labelOf = new Map(labels.map((l) => [l.recommendationId, l]))
  const groups = new Map<
    string,
    {
      marketplace: string
      directionId: string
      signalType: SelectionDimension
      samples: LabeledSample[]
    }
  >()
  for (const rec of recs) {
    const key = `${rec.marketplace}|${rec.directionId}|${rec.signalType}`
    const group = groups.get(key) ?? {
      marketplace: rec.marketplace,
      directionId: rec.directionId,
      signalType: rec.signalType,
      samples: [],
    }
    const label = labelOf.get(rec.id)
    if (label)
      group.samples.push({
        kind: rec.sampleKind as SampleKind,
        outcome: label.outcome,
        labeledOn: localDay(label.labeledAt, SELECTION_TIME_ZONE),
      })
    groups.set(key, group)
  }
  // 方向已删除的组合跳过（readiness_stat 外键随方向级联）
  const directions = new Set(
    (await s.select(direction, { fields: { id: direction.id } })).map((d) => d.id),
  )
  const calibrated = await weightsCalibrated(db, workspaceId)
  const baselines = new Map<string, BaselineResult>()
  const levels: Record<Readiness, number> = {
    'cold-start': 0,
    observation: 0,
    usable: 0,
    trusted: 0,
  }
  let written = 0
  for (const group of groups.values()) {
    if (!directions.has(group.directionId)) continue
    const baselineKey = `${group.marketplace}|${group.directionId}`
    let baseline = baselines.get(baselineKey)
    if (!baseline) {
      baseline = await directionBaseline(
        db,
        workspaceId,
        { directionId: group.directionId, marketplace: group.marketplace, asOf },
        options.criteria,
      )
      baselines.set(baselineKey, baseline)
    }
    const evaluation = evaluateReadiness(group.samples, {
      asOf,
      baseline: baseline.hitRate,
      weightsCalibrated: calibrated,
    })
    const { stats } = evaluation
    const values = {
      shadowCount: stats.counts.shadow,
      replayCount: stats.counts.replay,
      importCount: stats.counts.import,
      // 与各类型条数一致记未加权条数；Wilson 下界与有效样本按加权值
      hitCount: group.samples.filter((x) => x.outcome === 'hit').length,
      effectiveSamples: stats.effectiveSamples,
      wilsonLower: stats.lowerBound,
      baseline: baseline.hitRate,
      level: evaluation.level,
    }
    await s
      .insert(readinessStat, {
        marketplace: group.marketplace,
        directionId: group.directionId,
        signalType: group.signalType,
        computedOn: asOf,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          readinessStat.workspaceId,
          readinessStat.marketplace,
          readinessStat.directionId,
          readinessStat.signalType,
          readinessStat.computedOn,
        ],
        set: values,
      })
    levels[evaluation.level] += 1
    written += 1
  }
  return { workspaceId, groups: written, levels }
}

/** 每周准备度入口：逐个有推荐的空间重算 */
export async function runReadinessWeekly(
  db: Database,
  options: LabelOptions,
): Promise<ReadinessRunResult[]> {
  const workspaces = await db
    .selectDistinct({ workspaceId: recommendation.workspaceId })
    .from(recommendation)
  const out: ReadinessRunResult[] = []
  const transferring = await transferringWorkspaceIds(db)
  for (const { workspaceId } of workspaces) {
    if (transferring.has(workspaceId)) continue
    try {
      out.push(await recomputeReadiness(db, workspaceId, options))
    } catch (error) {
      log.error('selection.readiness_workspace_failed', { workspaceId, error })
    }
  }
  return out
}

/**
 * 选择性移动后重建空间准备度。旧组合可能已不再有推荐，先清掉派生统计再按当前样本重算。
 * 由 W3 finalize 在流转锁内调用；此处不接入流转引擎。
 */
export async function rebuildWorkspaceReadiness(
  db: Database,
  workspaceId: string,
  options: LabelOptions,
): Promise<ReadinessRunResult> {
  await scoped(db, workspaceId).delete(readinessStat, undefined)
  return recomputeReadiness(db, workspaceId, options)
}

/** 移出部分样本后，源空间未处理的整空间拟合建议失效；已处理的建议保留历史归属。 */
export async function dismissPendingWeightSuggestions(
  db: Database,
  workspaceId: string,
  requestedBy: string,
  now: Date,
): Promise<number> {
  const rows = await scoped(db, workspaceId)
    .update(
      weightSuggestion,
      { status: 'dismissed', resolvedBy: requestedBy, resolvedAt: now },
      eq(weightSuggestion.status, 'proposed'),
    )
    .returning({ id: weightSuggestion.id })
  return rows.length
}
