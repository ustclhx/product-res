import type { AcquisitionMethod, MetricName } from '@product-res/datasources'
import { addDays, diffDays } from './dates.ts'
import { DEFAULT_LEAD_TIMES, type LeadTimes, latestDecisionDate, slackDays } from './deadline.ts'
import {
  clamp,
  clampScore,
  coefficientOfVariation,
  inverseLogScale,
  linearScale,
  logScale,
  mean,
  median,
  pearson,
  SCALES,
  seasonIndexScale,
} from './scales.ts'
import type {
  DetailValue,
  DimensionId,
  DimensionResult,
  ObservationPoint,
  Platform,
  SourceRef,
} from './types.ts'

/**
 * 7 维信号（design D4）。输入是已读取好的观测序列，输出 0–100 的分数、所用输入的来源引用和中文理由。
 * 约定：缺少输入时 score 为 null，绝不当 0；数据存在且结论为“没有”时才给 0。
 */

/** 由配置或规则派生、非外部数据源的输入来源；置信度的新鲜度与来源一致性不计这些 */
export const INTERNAL_SOURCES = {
  config: 'selection-config',
  risk: 'risk-rules',
  /** M3 核算矩阵选定（或可计算）的组合，来自 costing_scenario 快照 */
  costing: 'costing_scenario',
} as const

/** 一个簇成员（平台商品）的某个指标序列 */
export interface MemberSeries {
  readonly entityId: string
  readonly points: readonly ObservationPoint[]
}

function result(
  dimension: DimensionId,
  score: number | null,
  inputs: readonly SourceRef[],
  reason: string,
  detail?: Record<string, DetailValue>,
): DimensionResult {
  return {
    dimension,
    score: score === null ? null : clampScore(score),
    inputs,
    reason,
    ...(detail ? { detail } : {}),
  }
}

function missing(dimension: DimensionId, reason: string): DimensionResult {
  return { dimension, score: null, inputs: [], reason }
}

function ref(metric: MetricName | string, point: ObservationPoint, entityId?: string): SourceRef {
  return entityId === undefined ? { ...point, metric } : { ...point, metric, entityId }
}

function internalRef(
  metric: string,
  value: number,
  asOf: string,
  sourceId: string,
  method: AcquisitionMethod = 'derived',
): SourceRef {
  return { metric, value, observedOn: asOf, sourceId, method, fetchedAt: `${asOf}T00:00:00.000Z` }
}

function sortedUpTo(points: readonly ObservationPoint[], asOf: string): ObservationPoint[] {
  return points
    .filter((p) => Number.isFinite(p.value) && diffDays(p.observedOn, asOf) >= 0)
    .sort((a, b) => a.observedOn.localeCompare(b.observedOn))
}

/** day 当天或之前最近的一个点 */
function latestOnOrBefore(
  sorted: readonly ObservationPoint[],
  day: string,
): ObservationPoint | undefined {
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i] as ObservationPoint
    if (diffDays(point.observedOn, day) >= 0) return point
  }
  return undefined
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

// ---------- 市场需求 ----------

export interface MarketDemandInput {
  readonly platform: Platform
  /** 计算日 YYYY-MM-DD；之后的观测忽略 */
  readonly asOf: string
  /** eBay：每个成员的 sold_quantity_total 快照 */
  readonly soldQuantityTotal?: readonly MemberSeries[] | undefined
  /** Amazon：每个成员的 sales_estimate_monthly 主值 */
  readonly salesEstimateMonthly?: readonly MemberSeries[] | undefined
  /** Amazon：每个成员的 BSR */
  readonly bsr?: readonly MemberSeries[] | undefined
}

export function marketDemand(input: MarketDemandInput): DimensionResult {
  return input.platform === 'ebay' ? ebayDemand(input) : amazonDemand(input)
}

function ebayDemand(input: MarketDemandInput): DimensionResult {
  const { asOf } = input
  const inputs: SourceRef[] = []
  let weekly = 0
  let weeklyMembers = 0
  // 加速度只用同时有 7 天和 30 天基线的成员，避免口径不一致
  let accelWeekly = 0
  let accelDaily30 = 0
  let accelMembers = 0

  for (const member of input.soldQuantityTotal ?? []) {
    const sorted = sortedUpTo(member.points, asOf)
    const latest = sorted.at(-1)
    if (!latest) continue
    const base7 = latestOnOrBefore(sorted, addDays(asOf, -7))
    if (!base7 || base7.observedOn >= latest.observedOn) continue
    const span7 = diffDays(base7.observedOn, latest.observedOn)
    // 累计已售回退（刊登重建等）按 0 增量处理
    const inc7 = (Math.max(0, latest.value - base7.value) * 7) / span7
    weekly += inc7
    weeklyMembers += 1
    inputs.push(
      ref('sold_quantity_total', latest, member.entityId),
      ref('sold_quantity_total', base7, member.entityId),
    )
    const base30 = latestOnOrBefore(sorted, addDays(asOf, -30))
    if (base30 && base30.observedOn < latest.observedOn) {
      const span30 = diffDays(base30.observedOn, latest.observedOn)
      accelWeekly += inc7
      accelDaily30 += Math.max(0, latest.value - base30.value) / span30
      accelMembers += 1
      inputs.push(ref('sold_quantity_total', base30, member.entityId))
    }
  }

  if (weeklyMembers === 0) {
    return missing('market-demand', '无数据：没有足够的已售数量快照（需要至少相隔 7 天的两次快照）')
  }

  const base = logScale(weekly, SCALES.ebayWeeklyUnits.floor, SCALES.ebayWeeklyUnits.ceiling)
  const { gain, maxBonus } = SCALES.acceleration
  let bonus = 0
  let acceleration: number | null = null
  if (accelMembers > 0) {
    const daily7 = accelWeekly / 7
    if (accelDaily30 > 0) {
      acceleration = daily7 / accelDaily30
      bonus = clamp((acceleration - 1) * gain, -maxBonus, maxBonus)
    } else if (daily7 > 0) {
      bonus = maxBonus
    }
  }
  const accelText =
    acceleration === null
      ? accelMembers > 0 && bonus > 0
        ? '，30 天前无销量、近期起量'
        : '，缺少 30 天基线未算加速度'
      : `，相对 30 天日均加速度 ${round(acceleration)} 倍`
  return result(
    'market-demand',
    base + bonus,
    inputs,
    `7 天销量增量约 ${Math.round(weekly)} 件（${weeklyMembers} 个成员）${accelText}`,
    {
      weeklyUnits: round(weekly, 1),
      ...(acceleration === null ? {} : { acceleration: round(acceleration, 3) }),
      salesAvailable: true,
    },
  )
}

function amazonDemand(input: MarketDemandInput): DimensionResult {
  const { asOf } = input
  const inputs: SourceRef[] = []
  let monthly = 0
  let salesMembers = 0
  for (const member of input.salesEstimateMonthly ?? []) {
    const latest = sortedUpTo(member.points, asOf).at(-1)
    if (!latest) continue
    monthly += Math.max(0, latest.value)
    salesMembers += 1
    inputs.push(ref('sales_estimate_monthly', latest, member.entityId))
  }
  let bestBsr: number | null = null
  for (const member of input.bsr ?? []) {
    const latest = sortedUpTo(member.points, asOf).at(-1)
    if (!latest || latest.value <= 0) continue
    bestBsr = bestBsr === null ? latest.value : Math.min(bestBsr, latest.value)
    inputs.push(ref('bsr', latest, member.entityId))
  }
  if (salesMembers === 0 && bestBsr === null) {
    return missing('market-demand', '无数据：没有销量估算或 BSR')
  }
  const salesScore =
    salesMembers > 0
      ? logScale(monthly, SCALES.amazonMonthlyUnits.floor, SCALES.amazonMonthlyUnits.ceiling)
      : null
  const bsrScore =
    bestBsr === null ? null : inverseLogScale(bestBsr, SCALES.bsr.best, SCALES.bsr.worst)
  const score =
    salesScore !== null && bsrScore !== null
      ? salesScore * SCALES.amazonBlend.sales + bsrScore * SCALES.amazonBlend.bsr
      : ((salesScore ?? bsrScore) as number)
  const parts = [
    salesScore === null ? null : `月销量估算约 ${Math.round(monthly)} 件`,
    bestBsr === null ? null : `最佳 BSR ${bestBsr}`,
  ].filter(Boolean)
  return result('market-demand', score, inputs, parts.join('，'), {
    ...(salesScore === null ? {} : { monthlyUnits: Math.round(monthly) }),
    ...(bestBsr === null ? {} : { bestBsr }),
    salesAvailable: salesScore !== null,
  })
}

// ---------- 增长与季节 ----------

export interface GrowthSeasonInput {
  readonly asOf: string
  /** 关联关键词（用作来源引用的实体） */
  readonly keyword?: string | undefined
  /** 关联节点关键词的 search_trend_index 月度序列 */
  readonly trend: readonly ObservationPoint[]
  /** 目标销售窗口覆盖的月份（1–12）；未关联节点时为空 */
  readonly targetMonths?: readonly number[] | undefined
}

export function growthSeason(input: GrowthSeasonInput): DimensionResult {
  const { asOf } = input
  const sorted = sortedUpTo(input.trend, asOf)
  if (sorted.length === 0) return missing('growth-season', '无数据：没有搜索趋势序列')

  // 按年月聚合，再按日历月得到季节轮廓
  const byYearMonth = new Map<string, number[]>()
  for (const point of sorted) {
    const key = point.observedOn.slice(0, 7)
    byYearMonth.set(key, [...(byYearMonth.get(key) ?? []), point.value])
  }
  const monthly = new Map<string, number>()
  for (const [key, values] of byYearMonth) monthly.set(key, mean(values) as number)
  const profile = new Map<number, number[]>()
  for (const [key, value] of monthly) {
    const month = Number(key.slice(5, 7))
    profile.set(month, [...(profile.get(month) ?? []), value])
  }
  const profileMean = new Map<number, number>()
  for (const [month, values] of profile) profileMean.set(month, mean(values) as number)

  const detail: Record<string, DetailValue> = {}
  const reasons: string[] = []
  let seasonScore: number | null = null
  const target = input.targetMonths ?? []
  const annual = mean([...profileMean.values()])
  if (
    target.length > 0 &&
    profileMean.size >= SCALES.seasonMinMonths &&
    target.every((m) => profileMean.has(m)) &&
    annual !== null &&
    annual > 0
  ) {
    const index = (mean(target.map((m) => profileMean.get(m) as number)) as number) / annual
    const stability = seasonStability(monthly)
    const effective = stability ?? SCALES.seasonSingleYearStability
    // 年际规律越不稳定，季节分越向中性 50 收缩
    seasonScore = 50 + (seasonIndexScale(index) - 50) * effective
    detail.seasonIndex = round(index, 3)
    if (stability !== null) detail.seasonStability = round(stability, 3)
    reasons.push(
      `季节指数 ${round(index)}`,
      stability === null ? '仅一年数据，规律未验证' : `年际相关 ${round(stability)}`,
    )
  } else if (target.length > 0) {
    reasons.push('季节轮廓月份不足，未算季节指数')
  }

  let growthBonus: number | null = null
  const latest = sorted.at(-1) as ObservationPoint
  const base = latestOnOrBefore(sorted, addDays(asOf, -90))
  if (base && base.value > 0 && base.observedOn < latest.observedOn) {
    const growth = latest.value / base.value - 1
    const { gain, maxBonus } = SCALES.growth90
    growthBonus = clamp(growth * gain, -maxBonus, maxBonus)
    detail.growth90 = round(growth, 3)
    reasons.push(`近 90 天增长 ${Math.round(growth * 100)}%`)
  }

  if (seasonScore === null && growthBonus === null) {
    return missing('growth-season', `无数据：${reasons[0] ?? '趋势序列不足 90 天且未关联节点'}`)
  }
  return result(
    'growth-season',
    (seasonScore ?? 50) + (growthBonus ?? 0),
    sorted.map((p) => ref('search_trend_index', p, input.keyword)),
    reasons.join('，'),
    detail,
  )
}

/** 相邻年份同月趋势值的平均相关系数（截断到 0–1）；不足两年可比时为 null */
function seasonStability(monthly: ReadonlyMap<string, number>): number | null {
  const years = new Map<number, Map<number, number>>()
  for (const [key, value] of monthly) {
    const year = Number(key.slice(0, 4))
    const months = years.get(year) ?? new Map<number, number>()
    months.set(Number(key.slice(5, 7)), value)
    years.set(year, months)
  }
  const ordered = [...years.keys()].sort((a, b) => a - b)
  const correlations: number[] = []
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = years.get(ordered[i - 1] as number) as Map<number, number>
    const curr = years.get(ordered[i] as number) as Map<number, number>
    const common = [...prev.keys()].filter((m) => curr.has(m)).sort((a, b) => a - b)
    const r = pearson(
      common.map((m) => prev.get(m) as number),
      common.map((m) => curr.get(m) as number),
    )
    if (r !== null) correlations.push(r)
  }
  const avg = mean(correlations)
  return avg === null ? null : clamp(avg, 0, 1)
}

// ---------- 同行扩散 ----------

/** 簇成员在对标店铺的首次出现记录 */
export interface ListingSighting {
  readonly entityId: string
  readonly sellerId: string
  /** 首次出现（上架）日 YYYY-MM-DD */
  readonly firstSeenOn: string
  readonly sourceId: string
  readonly method: AcquisitionMethod
  readonly fetchedAt: string
}

export interface PeerSpreadInput {
  readonly asOf: string
  /** 种子与已接受的对标店铺 */
  readonly benchmarkSellerIds: readonly string[]
  readonly listings: readonly ListingSighting[]
}

export function peerSpread(input: PeerSpreadInput): DimensionResult {
  const { asOf } = input
  if (input.benchmarkSellerIds.length === 0) {
    return missing('peer-spread', '无数据：方向没有种子或已接受的对标店铺')
  }
  if (input.listings.length === 0) return missing('peer-spread', '无数据：没有店铺上新记录')
  const benchmark = new Set(input.benchmarkSellerIds)
  const { windowDays, fullShops, shopsWeight, concentrationBonus } = SCALES.peerSpread
  const firstBySeller = new Map<string, ListingSighting>()
  for (const listing of input.listings) {
    const age = diffDays(listing.firstSeenOn, asOf)
    if (!benchmark.has(listing.sellerId) || age < 0 || age > windowDays) continue
    const prev = firstBySeller.get(listing.sellerId)
    if (!prev || listing.firstSeenOn < prev.firstSeenOn)
      firstBySeller.set(listing.sellerId, listing)
  }
  const sightings = [...firstBySeller.values()]
  const shops = sightings.length
  let concentration = 0
  if (shops >= 2) {
    const days = sightings.map((s) => s.firstSeenOn).sort()
    const span = diffDays(days[0] as string, days.at(-1) as string)
    concentration = 1 - span / windowDays
  }
  const score =
    (Math.min(shops, fullShops) / fullShops) * shopsWeight + concentration * concentrationBonus
  const inputs = sightings.map((s) => ({
    metric: 'first_seen',
    value: diffDays(s.firstSeenOn, asOf),
    observedOn: s.firstSeenOn,
    sourceId: s.sourceId,
    method: s.method,
    fetchedAt: s.fetchedAt,
    entityId: s.entityId,
  }))
  const reason =
    shops === 0
      ? `${windowDays} 天内没有对标店铺上架同簇商品`
      : `${windowDays} 天内 ${shops} 家对标店铺上架同簇商品${shops >= 2 ? `，上新集中度 ${round(concentration)}` : ''}`
  return result('peer-spread', score, inputs, reason, {
    shops,
    concentration: round(concentration, 3),
  })
}

// ---------- 利润空间 ----------

export interface FeeParams {
  readonly commissionRate: number
  readonly fixedFee: number
  readonly returnRate: number
}

export interface LogisticsCost {
  readonly plan: string
  /** 每件落地成本（采购 + 头程等），与价格同币种 */
  readonly landedCost: number
}

export interface ProfitInput {
  readonly platform: Platform
  readonly asOf: string
  /** 每个竞品成员的 price 序列 */
  readonly prices: readonly MemberSeries[]
  /** 各物流方案的落地成本；M3 核算前通常为空 */
  readonly landedCosts?: readonly LogisticsCost[] | null | undefined
  readonly fees?: FeeParams | undefined
  /** M3 核算结果；给出时直接采用其毛利率（已含实际费率），不再按默认费率估算 */
  readonly costed?: CostedProfit | null | undefined
}

/** 核算组合的利润结果（金额为最小单位整数） */
export interface CostedProfit {
  /** costing_scenario 的 ID，作为来源引用的实体 */
  readonly scenarioId: string
  /** 组合说明，如「供应商 A · FBA」 */
  readonly plan: string
  readonly currency: string
  readonly salePriceMinor: number
  readonly landedCostMinor: number
  /** 净利润 ÷ 售价 */
  readonly grossMargin: number
  /** 是否为团队选定的组合（否则为可计算组合中毛利率最高的一个） */
  readonly selected: boolean
}

const minor = (amount: number, currency: string) => `${(amount / 100).toFixed(2)} ${currency}`

export function profit(input: ProfitInput): DimensionResult {
  const inputs: SourceRef[] = []
  const latestPrices: number[] = []
  for (const member of input.prices) {
    const latest = sortedUpTo(member.points, input.asOf).at(-1)
    if (!latest || latest.value <= 0) continue
    latestPrices.push(latest.value)
    inputs.push(ref('price', latest, member.entityId))
  }
  const price = median(latestPrices)
  const costed = input.costed
  if (costed) {
    // 核算结果优先：售价、落地成本、平台费与退货预留都已在矩阵中按团队参数计算
    const margin = costed.grossMargin
    const costRef: SourceRef = {
      ...internalRef('gross_margin', round(margin, 4), input.asOf, INTERNAL_SOURCES.costing),
      entityId: costed.scenarioId,
    }
    return result(
      'profit',
      linearScale(margin, SCALES.margin.low, SCALES.margin.high),
      [...inputs, costRef],
      `核算${costed.selected ? '选定' : '最优'}组合「${costed.plan}」：售价 ${minor(costed.salePriceMinor, costed.currency)}，落地成本 ${minor(costed.landedCostMinor, costed.currency)}，毛利率 ${Math.round(margin * 100)}%`,
      {
        ...(price === null ? {} : { medianPrice: round(price) }),
        bestMargin: round(margin, 4),
        bestPlan: costed.plan,
        source: INTERNAL_SOURCES.costing,
        scenarioId: costed.scenarioId,
      },
    )
  }
  if (price === null) return missing('profit', '无数据：没有竞品价格')
  const costs = input.landedCosts ?? []
  if (costs.length === 0) return missing('profit', '无数据：没有落地成本（待核算）')
  const fees = input.fees ?? SCALES.defaultFees[input.platform]
  let best: { plan: string; margin: number } | null = null
  for (const cost of costs) {
    const net =
      price -
      price * fees.commissionRate -
      fees.fixedFee -
      price * fees.returnRate -
      cost.landedCost
    const margin = net / price
    if (!best || margin > best.margin) best = { plan: cost.plan, margin }
  }
  const { plan, margin } = best as { plan: string; margin: number }
  return result(
    'profit',
    linearScale(margin, SCALES.margin.low, SCALES.margin.high),
    inputs,
    `竞品中位价 ${round(price)}，最优方案「${plan}」估算毛利率 ${Math.round(margin * 100)}%`,
    { medianPrice: round(price), bestMargin: round(margin, 4), bestPlan: plan },
  )
}

// ---------- 竞争强度（反向：分数越高竞争越激烈） ----------

export interface CompetitionInput {
  readonly asOf: string
  /** 簇级卖家数序列 */
  readonly sellerCount?: readonly ObservationPoint[] | undefined
  /** 每个成员的 price 序列 */
  readonly prices?: readonly MemberSeries[] | undefined
  /** 每个成员的 review_count 序列 */
  readonly reviewCounts?: readonly MemberSeries[] | undefined
  /** 头部卖家/品牌份额（0–1） */
  readonly topShare?: ObservationPoint | null | undefined
}

export function competition(input: CompetitionInput): DimensionResult {
  const { asOf } = input
  const scales = SCALES.competition
  const inputs: SourceRef[] = []
  const parts: number[] = []
  const reasons: string[] = []
  const detail: Record<string, DetailValue> = {}

  const sellers = sortedUpTo(input.sellerCount ?? [], asOf)
  const sellerNow = sellers.at(-1)
  const sellerBase = latestOnOrBefore(sellers, addDays(asOf, -30))
  if (
    sellerNow &&
    sellerBase &&
    sellerBase.value > 0 &&
    sellerBase.observedOn < sellerNow.observedOn
  ) {
    const growth = sellerNow.value / sellerBase.value - 1
    parts.push(linearScale(growth, scales.sellerGrowth.low, scales.sellerGrowth.high))
    inputs.push(ref('seller_count', sellerNow), ref('seller_count', sellerBase))
    detail.sellerGrowth = round(growth, 3)
    reasons.push(`卖家数 30 天变化 ${Math.round(growth * 100)}%`)
  }

  // 每日最低价序列：价格跌幅与波动率（波动率供置信度的竞争稳定性使用）
  const dailyLowest = new Map<string, number>()
  let lowNow: { value: number; point: ObservationPoint; entityId: string } | null = null
  let lowThen: { value: number; point: ObservationPoint; entityId: string } | null = null
  for (const member of input.prices ?? []) {
    const sorted = sortedUpTo(member.points, asOf).filter((p) => p.value > 0)
    for (const point of sorted) {
      if (diffDays(point.observedOn, asOf) <= 30) {
        const prev = dailyLowest.get(point.observedOn)
        dailyLowest.set(
          point.observedOn,
          prev === undefined ? point.value : Math.min(prev, point.value),
        )
      }
    }
    const latest = sorted.at(-1)
    if (latest && (!lowNow || latest.value < lowNow.value)) {
      lowNow = { value: latest.value, point: latest, entityId: member.entityId }
    }
    const then = latestOnOrBefore(sorted, addDays(asOf, -30))
    if (then && (!lowThen || then.value < lowThen.value)) {
      lowThen = { value: then.value, point: then, entityId: member.entityId }
    }
  }
  if (lowNow && lowThen && lowThen.point.observedOn < lowNow.point.observedOn) {
    const drop = 1 - lowNow.value / lowThen.value
    parts.push(linearScale(drop, scales.priceDrop.low, scales.priceDrop.high))
    inputs.push(
      ref('price', lowNow.point, lowNow.entityId),
      ref('price', lowThen.point, lowThen.entityId),
    )
    detail.priceDrop = round(drop, 3)
    reasons.push(`最低价 30 天跌幅 ${Math.round(drop * 100)}%`)
  }
  const cv = coefficientOfVariation([...dailyLowest.values()])
  if (cv !== null) detail.priceCv = round(cv, 4)

  if (input.topShare) {
    parts.push(linearScale(input.topShare.value, scales.topShare.low, scales.topShare.high))
    inputs.push(ref('top_share', input.topShare))
    detail.topShare = round(input.topShare.value, 3)
    reasons.push(`头部份额 ${Math.round(input.topShare.value * 100)}%`)
  }

  const reviews: number[] = []
  for (const member of input.reviewCounts ?? []) {
    const latest = sortedUpTo(member.points, asOf).at(-1)
    if (!latest) continue
    reviews.push(latest.value)
    inputs.push(ref('review_count', latest, member.entityId))
  }
  const reviewMedian = median(reviews)
  if (reviewMedian !== null) {
    parts.push(logScale(reviewMedian, scales.reviewMedian.floor, scales.reviewMedian.ceiling))
    detail.reviewMedian = reviewMedian
    reasons.push(`评论数中位数 ${Math.round(reviewMedian)}`)
  }

  const score = mean(parts)
  if (score === null) {
    return missing('competition', '无数据：没有卖家数、价格历史、头部份额或评论数')
  }
  return result('competition', score, inputs, reasons.join('，'), detail)
}

// ---------- 供应与时效（反向：分数越高越来不及） ----------

export interface LogisticsPlan {
  readonly plan: string
  readonly leadTimes: LeadTimes
}

export interface SupplyTimingInput {
  readonly asOf: string
  readonly platform: Platform
  /** 关联节点的下一次销售开始日；未关联节点时为空 */
  readonly salesStart?: string | null | undefined
  /** 核算的物流方案；为空时使用默认提前期 */
  readonly plans?: readonly LogisticsPlan[] | undefined
  readonly improved?: boolean | undefined
  /** M3 核算组合给出的最晚决定日；给出时直接采用，不再按默认提前期推算 */
  readonly costed?: CostedTiming | null | undefined
}

export interface CostedTiming {
  readonly scenarioId: string
  readonly plan: string
  /** 核算矩阵算出的最晚决定日 */
  readonly deadline: string
  /** 总提前期（销售开始日 − 最晚决定日） */
  readonly leadDays: number
}

export function supplyTiming(input: SupplyTimingInput): DimensionResult {
  const { asOf } = input
  if (input.costed) return costedTiming(asOf, input.costed)
  if (!input.salesStart) return missing('supply-timing', '无数据：未关联销售节点')
  const usedDefaultLeadTime = !input.plans || input.plans.length === 0
  const plans: readonly LogisticsPlan[] = usedDefaultLeadTime
    ? [{ plan: '默认提前期', leadTimes: DEFAULT_LEAD_TIMES[input.platform] }]
    : (input.plans as readonly LogisticsPlan[])
  let best: { plan: string; deadline: string; slack: number; lead: number } | null = null
  for (const plan of plans) {
    const { deadline, totalLeadDays } = latestDecisionDate({
      ...plan.leadTimes,
      salesStart: input.salesStart,
      platform: input.platform,
      improved: input.improved,
    })
    const slack = slackDays(deadline, asOf)
    if (!best || slack > best.slack) {
      best = { plan: plan.plan, deadline, slack, lead: totalLeadDays }
    }
  }
  const { plan, deadline, slack, lead } = best as NonNullable<typeof best>
  const allPlansLate = slack < 0
  const { onTimeMax, late } = SCALES.supplyTiming
  const ratio = lead > 0 ? slack / lead : 1
  const score = allPlansLate ? late : onTimeMax * (1 - Math.min(Math.max(ratio, 0), 1))
  const reason = allPlansLate
    ? `所有物流方案都来不及：最晚决定日 ${deadline} 已过`
    : `最优方案「${plan}」最晚决定日 ${deadline}，余量 ${slack} 天 / 提前期 ${lead} 天${usedDefaultLeadTime ? '（默认提前期）' : ''}`
  return result(
    'supply-timing',
    score,
    [internalRef('slack_days', slack, asOf, INTERNAL_SOURCES.config)],
    reason,
    {
      deadline,
      slackDays: slack,
      leadDays: lead,
      allPlansLate,
      usedDefaultLeadTime,
      bestPlan: plan,
    },
  )
}

/** 按核算组合的最晚决定日计算供应与时效；分数换算与默认路径一致 */
function costedTiming(asOf: string, costed: CostedTiming): DimensionResult {
  const { plan, deadline, leadDays } = costed
  const slack = slackDays(deadline, asOf)
  const late = slack < 0
  const { onTimeMax, late: lateScore } = SCALES.supplyTiming
  const ratio = leadDays > 0 ? slack / leadDays : 1
  const score = late ? lateScore : onTimeMax * (1 - Math.min(Math.max(ratio, 0), 1))
  const ref: SourceRef = {
    ...internalRef('slack_days', slack, asOf, INTERNAL_SOURCES.costing),
    entityId: costed.scenarioId,
  }
  return result(
    'supply-timing',
    score,
    [ref],
    late
      ? `核算组合「${plan}」来不及：最晚决定日 ${deadline} 已过`
      : `核算组合「${plan}」最晚决定日 ${deadline}，余量 ${slack} 天 / 提前期 ${leadDays} 天`,
    {
      deadline,
      slackDays: slack,
      leadDays,
      // 核算只给出所选（或最优）组合；它来不及即视为来不及
      allPlansLate: late,
      usedDefaultLeadTime: false,
      bestPlan: plan,
      source: INTERNAL_SOURCES.costing,
      scenarioId: costed.scenarioId,
    },
  )
}

// ---------- 合规与侵权 ----------

export interface RiskFindingInput {
  readonly type: string
  readonly level: 'high' | 'medium' | 'low'
  readonly veto?: boolean | undefined
  readonly basis: string
}

export interface ComplianceInput {
  readonly asOf: string
  /** 风险检查结果；未做检查时为 null */
  readonly findings: readonly RiskFindingInput[] | null
}

export function compliance(input: ComplianceInput): DimensionResult {
  if (input.findings === null) return missing('compliance', '无数据：尚未做风险检查')
  const penalties = SCALES.compliancePenalty
  const veto = input.findings.some((f) => f.veto || f.level === 'high')
  const total = input.findings.reduce((sum, f) => sum + penalties[f.level], 0)
  const inputs = input.findings.map((f) =>
    internalRef(`risk:${f.type}`, penalties[f.level], input.asOf, INTERNAL_SOURCES.risk),
  )
  const reason =
    input.findings.length === 0
      ? '未发现风险'
      : `${veto ? '高风险一票否决：' : '风险扣分：'}${input.findings.map((f) => f.basis).join('；')}`
  return result('compliance', veto ? 0 : 100 - total, inputs, reason, { veto })
}
