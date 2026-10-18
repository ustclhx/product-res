import type { Marketplace } from '@product-res/datasources'
import {
  type BrandEntry,
  brandEntry,
  clusterMember,
  clusterSignal,
  cluster as clusterTable,
  type Database,
  type Direction,
  direction,
  directionSeller,
  lead,
  type RiskRule,
  riskFinding,
  riskRule,
  type SeasonalNode,
  type SelectionDimension,
  scoped,
  seasonalNode,
} from '@product-res/db'
import {
  findProducts,
  keywordIds,
  type MarketProduct,
  type MetricPoint,
  type MetricSeriesMap,
  productsByIds,
  readMetricSeries,
} from '@product-res/marketdata'
import {
  checkRisks,
  type BrandEntry as RiskBrand,
  type RiskResult,
  type RiskRule as RiskRuleInput,
} from '@product-res/risk'
import {
  addDays,
  assignClusters,
  type ClusterMember,
  type ClusterProduct,
  competition,
  compliance,
  computeConfidence,
  type DimensionResult,
  diffDays,
  evaluateLead,
  growthSeason,
  type ListingSighting,
  type MemberSeries,
  marketDemand,
  needsAttention,
  nextOccurrence,
  type ObservationPoint,
  type Platform,
  peerSpread,
  platformOf,
  productKey,
  profit,
  type Readiness,
  rankKey,
  type ScoringSettings,
  type SourceRef,
  supplyTiming,
} from '@product-res/selection'
import { newId } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm'
import { GRADE_TO_DB, METHOD_FROM_DB, METHOD_TO_DB } from './mapping.ts'
import { currentScoringSetting, toScoringSettings } from './settings.ts'

/**
 * 跟卖选品每日流水线（design D7，tasks 3.1）：对每个空间的每个启用方向
 * 读取范围内的市场商品 → 归并为簇 → 7 维信号 → 风险 → 综合分、门槛、等级、置信度 → 写库。
 * 按 簇 × 日期 upsert，同一天重复运行不产生重复线索。
 */

/** 每日流水线的时区：日期按新加坡时间计 */
export const SELECTION_TIME_ZONE = 'Asia/Singapore'

/** M5（回测与准备度）之前全部按冷启动处理 */
const READINESS: Readiness = 'cold-start'

/** 没有关联跟卖方式配置前按“同款同货源”检查风险（更严格） */
const FOLLOW_MODE = 'same-source' as const

/** 商品首次出现记录的来源标识（来自 marketplace_product 的上架 / 首次发现时间） */
export const CATALOG_SOURCE = 'marketplace-catalog'

const PRODUCT_METRICS = [
  'sold_quantity_total',
  'sales_estimate_monthly',
  'bsr',
  'price',
  'review_count',
  'seller_count',
] as const
/** 商品指标的读取窗口：需求与竞争最多回看 30 天，留出缺测余量 */
const PRODUCT_WINDOW_DAYS = 60
/** 搜索趋势读取窗口：季节稳定性需要多年同月对比 */
const TREND_WINDOW_DAYS = 5 * 366
/** 覆盖度统计的快照窗口 */
const COVERAGE_WINDOW_DAYS = 30

/** 某时刻在指定时区的日期 YYYY-MM-DD */
export function localDay(at: Date, timeZone = SELECTION_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const day = (at: Date) => at.toISOString().slice(0, 10)
const round2 = (value: number) => Math.round(value * 100) / 100

export interface DirectionRunResult {
  readonly directionId: string
  readonly clusters: number
  readonly createdClusters: number
  readonly leads: number
}

export interface WorkspaceRunResult {
  readonly workspaceId: string
  readonly directions: readonly DirectionRunResult[]
  readonly failures: readonly { directionId: string; error: string }[]
}

export interface RunOptions {
  readonly now: Date
  /** 计算日；默认按新加坡时间取 now 的日期 */
  readonly asOf?: string | undefined
}

/**
 * 每日入口：列出有启用方向的空间并逐个运行。单个方向失败只记录日志，不影响其他方向。
 */
export async function runSelectionDaily(
  db: Database,
  options: RunOptions,
): Promise<WorkspaceRunResult[]> {
  // 系统任务需要跨空间列出“有启用方向的空间”；之后的读写都经 scoped() 限定在单个空间
  const workspaces = await db
    .selectDistinct({ workspaceId: direction.workspaceId })
    .from(direction)
    .where(eq(direction.enabled, true))
  const results: WorkspaceRunResult[] = []
  for (const { workspaceId } of workspaces) {
    try {
      results.push(await runSelectionForWorkspace(db, workspaceId, options))
    } catch (error) {
      log.error('selection.workspace_failed', { workspaceId, error })
    }
  }
  return results
}

interface WorkspaceContext {
  readonly db: Database
  readonly workspaceId: string
  readonly asOf: string
  readonly now: Date
  readonly settings: ScoringSettings
  readonly brands: readonly BrandEntry[]
  readonly rules: readonly RiskRule[]
  readonly nodes: ReadonlyMap<string, SeasonalNode>
  /** 方向 ID → 种子与已接受的对标店铺 */
  readonly benchmarks: ReadonlyMap<string, readonly { marketplace: string; sellerId: string }[]>
}

/** 运行一个空间的全部启用方向（也供人工刷新使用） */
export async function runSelectionForWorkspace(
  db: Database,
  workspaceId: string,
  options: RunOptions,
): Promise<WorkspaceRunResult> {
  const s = scoped(db, workspaceId)
  const settings = toScoringSettings(await currentScoringSetting(db, workspaceId))
  const [directions, brands, rules, nodes, sellers] = await Promise.all([
    s.select(direction, { where: eq(direction.enabled, true) }).orderBy(direction.createdAt),
    s.select(brandEntry),
    s.select(riskRule, { where: eq(riskRule.enabled, true) }),
    s.select(seasonalNode),
    s.select(directionSeller, {
      where: inArray(directionSeller.status, ['seed', 'accepted']),
    }),
  ])
  const benchmarks = new Map<string, { marketplace: string; sellerId: string }[]>()
  for (const seller of sellers) {
    const list = benchmarks.get(seller.directionId) ?? []
    list.push({ marketplace: seller.marketplace, sellerId: seller.sellerPlatformId })
    benchmarks.set(seller.directionId, list)
  }
  const context: WorkspaceContext = {
    db,
    workspaceId,
    asOf: options.asOf ?? localDay(options.now),
    now: options.now,
    settings,
    brands,
    rules,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    benchmarks,
  }
  const results: DirectionRunResult[] = []
  const failures: { directionId: string; error: string }[] = []
  for (const row of directions) {
    try {
      const result = await runDirection(context, row)
      results.push(result)
      log.info('selection.direction_done', { workspaceId, ...result })
    } catch (error) {
      failures.push({
        directionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
      log.error('selection.direction_failed', { workspaceId, directionId: row.id, error })
    }
  }
  return { workspaceId, directions: results, failures }
}

function toClusterProduct(product: MarketProduct): ClusterProduct {
  return {
    marketplace: product.marketplace as Marketplace,
    platformId: product.platformId,
    title: product.title ?? undefined,
    brand: product.brand ?? undefined,
    gtin: product.gtin ?? undefined,
    categoryId: product.categoryId ?? undefined,
  }
}

const keyOf = (product: MarketProduct) =>
  productKey({ marketplace: product.marketplace as Marketplace, platformId: product.platformId })

async function runDirection(ctx: WorkspaceContext, row: Direction): Promise<DirectionRunResult> {
  const { db, workspaceId } = ctx
  const s = scoped(db, workspaceId)
  const benchmark = ctx.benchmarks.get(row.id) ?? []

  // 1. 方向范围内的商品与已有成员
  const scopeProducts = await findProducts(db, {
    marketplaces: row.marketplaces as Marketplace[],
    categoryIds: row.categoryIds,
    sellers: benchmark,
    keywords: row.keywords,
  })
  const clusters = await s.select(clusterTable, { where: eq(clusterTable.directionId, row.id) })
  const clusterIds = clusters.map((c) => c.id)
  const members =
    clusterIds.length === 0
      ? []
      : await s.select(clusterMember, { where: inArray(clusterMember.clusterId, clusterIds) })
  const products = new Map<string, MarketProduct>(scopeProducts.map((p) => [p.id, p]))
  const missing = members.map((m) => m.productId).filter((id) => !products.has(id))
  for (const product of await productsByIds(db, missing)) products.set(product.id, product)
  const byKey = new Map([...products.values()].map((p) => [keyOf(p), p]))

  // 2. 归并：已有成员（含锁定）原样保留，新商品依次按 GTIN、标题相似匹配，否则新建簇
  const existing: ClusterMember[] = members.flatMap((m) => {
    const product = products.get(m.productId)
    return product
      ? [
          {
            clusterId: m.clusterId,
            productKey: keyOf(product),
            method: METHOD_FROM_DB[m.method],
            confidence: m.confidence,
            locked: m.locked,
          },
        ]
      : []
  })
  const assigned = assignClusters({
    products: scopeProducts.map(toClusterProduct),
    existing,
    knownProducts: [...products.values()].map(toClusterProduct),
    brandWords: ctx.brands.map((b) => b.name),
    newClusterId: newId,
  })
  const added = assigned.members.slice(existing.length)
  if (added.length > 0) {
    await s.transaction(async (tx) => {
      const created = new Set(assigned.createdClusterIds)
      const firstOf = new Map<string, MarketProduct>()
      for (const member of added) {
        const product = byKey.get(member.productKey) as MarketProduct
        if (created.has(member.clusterId) && !firstOf.has(member.clusterId))
          firstOf.set(member.clusterId, product)
      }
      if (firstOf.size > 0) {
        await tx.insert(
          clusterTable,
          [...firstOf].map(([id, product]) => ({
            id,
            directionId: row.id,
            marketplace: product.marketplace,
            representativeProductId: product.id,
            name: (product.title ?? product.platformId).slice(0, 200),
          })),
        )
      }
      await tx
        .insert(
          clusterMember,
          added.map((member) => ({
            clusterId: member.clusterId,
            productId: (byKey.get(member.productKey) as MarketProduct).id,
            method: METHOD_TO_DB[member.method],
            confidence: member.confidence,
            locked: member.locked,
          })),
        )
        .onConflictDoNothing()
    })
  }

  // 3. 逐簇计算并写入
  const active = await s.select(clusterTable, {
    where: and(eq(clusterTable.directionId, row.id), eq(clusterTable.status, 'active')) as SQL,
  })
  const allMembers =
    active.length === 0
      ? []
      : await s.select(clusterMember, {
          where: inArray(
            clusterMember.clusterId,
            active.map((c) => c.id),
          ),
        })
  const membersOf = new Map<string, typeof allMembers>()
  for (const member of allMembers) {
    membersOf.set(member.clusterId, [...(membersOf.get(member.clusterId) ?? []), member])
  }
  const series = await readProductSeries(ctx, active, allMembers)
  const timing = targetNode(ctx, row)
  const trends = await readTrends(ctx, row, active)

  let leads = 0
  for (const c of active) {
    const platform = platformOf(c.marketplace as Marketplace)
    const clusterMembers = membersOf.get(c.id) ?? []
    if (!platform || clusterMembers.length === 0) continue
    const memberProducts = clusterMembers
      .map((m) => products.get(m.productId))
      .filter((p): p is MarketProduct => p !== undefined)
    await evaluateCluster(ctx, {
      row,
      clusterId: c.id,
      marketplace: c.marketplace,
      platform,
      products: memberProducts,
      memberConfidences: clusterMembers.map((m) => m.confidence),
      series: series.get(c.marketplace) ?? new Map(),
      benchmark: benchmark.filter((b) => b.marketplace === c.marketplace).map((b) => b.sellerId),
      timing,
      trend: trends.get(c.marketplace) ?? null,
    })
    leads += 1
  }
  return {
    directionId: row.id,
    clusters: active.length,
    createdClusters: assigned.createdClusterIds.length,
    leads,
  }
}

/** 按站点批量读取簇成员的商品指标（来源优先级按站点） */
async function readProductSeries(
  ctx: WorkspaceContext,
  clusters: readonly { id: string; marketplace: string }[],
  members: readonly { clusterId: string; productId: string }[],
): Promise<Map<string, MetricSeriesMap>> {
  const marketOf = new Map(clusters.map((c) => [c.id, c.marketplace]))
  const idsByMarket = new Map<string, string[]>()
  for (const member of members) {
    const market = marketOf.get(member.clusterId) as string
    idsByMarket.set(market, [...(idsByMarket.get(market) ?? []), member.productId])
  }
  const out = new Map<string, MetricSeriesMap>()
  for (const [marketplace, entityIds] of idsByMarket) {
    out.set(
      marketplace,
      await readMetricSeries(ctx.db, {
        entityType: 'product',
        entityIds,
        metrics: PRODUCT_METRICS,
        marketplace: marketplace as Marketplace,
        from: addDays(ctx.asOf, -PRODUCT_WINDOW_DAYS),
        to: ctx.asOf,
      }),
    )
  }
  return out
}

interface NodeTiming {
  readonly node: SeasonalNode
  readonly salesStart: string
  readonly targetMonths: readonly number[]
}

/** 方向关联节点中下一次起卖日最近的一个 */
function targetNode(ctx: WorkspaceContext, row: Direction): NodeTiming | null {
  let best: NodeTiming | null = null
  for (const id of row.nodeIds) {
    const node = ctx.nodes.get(id)
    if (!node) continue
    const salesStart = nextOccurrence(node.startMonth, node.startDay, ctx.asOf)
    if (best && diffDays(best.salesStart, salesStart) >= 0) continue
    const months = new Set<number>()
    for (let i = 0; i < node.salesDays; i += 1) {
      months.add(Number(addDays(salesStart, i).slice(5, 7)))
    }
    best = { node, salesStart, targetMonths: [...months].sort((a, b) => a - b) }
  }
  return best
}

interface Trend {
  readonly keyword: string
  readonly points: readonly ObservationPoint[]
  readonly raw: readonly MetricPoint[]
}

/**
 * 每个站点选一个有搜索趋势数据的关键词：节点关键词优先，其次方向关键词；
 * 同站点的关键词优先，没有时用其他站点（如 global）的同名关键词。
 */
async function readTrends(
  ctx: WorkspaceContext,
  row: Direction,
  clusters: readonly { marketplace: string }[],
): Promise<Map<string, Trend>> {
  const out = new Map<string, Trend>()
  const node = targetNode(ctx, row)?.node
  const phrases = [
    ...new Set([...(node?.keywords ?? []), ...row.keywords].map((k) => k.trim().toLowerCase())),
  ].filter(Boolean)
  if (phrases.length === 0 || clusters.length === 0) return out
  const keywords = await keywordIds(ctx.db, phrases)
  if (keywords.length === 0) return out
  const markets = [...new Set(clusters.map((c) => c.marketplace))]
  for (const marketplace of markets) {
    const data = await readMetricSeries(ctx.db, {
      entityType: 'keyword',
      entityIds: keywords.map((k) => k.id),
      metrics: ['search_trend_index'],
      marketplace: marketplace as Marketplace,
      from: addDays(ctx.asOf, -TREND_WINDOW_DAYS),
      to: ctx.asOf,
    })
    const candidates = phrases.flatMap((phrase) =>
      keywords
        .filter((k) => k.phrase === phrase)
        .sort(
          (a, b) => Number(b.marketplace === marketplace) - Number(a.marketplace === marketplace),
        ),
    )
    for (const keyword of candidates) {
      const raw = data.get(keyword.id)?.get('search_trend_index') ?? []
      if (raw.length === 0) continue
      out.set(marketplace, { keyword: keyword.phrase, points: raw.map(toPoint), raw })
      break
    }
  }
  return out
}

function toPoint(point: MetricPoint): ObservationPoint {
  return {
    value: point.primary.value,
    observedOn: point.observedOn,
    sourceId: point.primary.sourceId,
    method: point.primary.method,
    fetchedAt: point.primary.fetchedAt.toISOString(),
  }
}

function memberSeries(
  products: readonly MarketProduct[],
  series: MetricSeriesMap,
  metric: string,
): MemberSeries[] {
  return products.map((p) => ({
    entityId: p.id,
    points: (series.get(p.id)?.get(metric) ?? []).map(toPoint),
  }))
}

/** 簇级卖家数：同一天各成员卖家数之和（Amazon 每个 ASIN 的在售卖家数） */
function clusterSellerCount(
  products: readonly MarketProduct[],
  series: MetricSeriesMap,
): ObservationPoint[] {
  const byDay = new Map<string, MetricPoint[]>()
  for (const p of products) {
    for (const point of series.get(p.id)?.get('seller_count') ?? []) {
      byDay.set(point.observedOn, [...(byDay.get(point.observedOn) ?? []), point])
    }
  }
  return [...byDay].map(([observedOn, points]) => {
    const first = points[0] as MetricPoint
    const latest = points.reduce(
      (a, b) => (b.primary.fetchedAt > a ? b.primary.fetchedAt : a),
      first.primary.fetchedAt,
    )
    return {
      value: points.reduce((sum, p) => sum + p.primary.value, 0),
      observedOn,
      sourceId: first.primary.sourceId,
      method: points.length > 1 ? 'derived' : first.primary.method,
      fetchedAt: latest.toISOString(),
    }
  })
}

/**
 * 信号只用每天的主值计算；同一实体同一天的其他来源值作为额外来源引用附在维度输入后，
 * 供置信度的“来源一致性”与详情页的来源对比使用。
 */
function withAlternates(
  dimension: DimensionResult,
  lookup: ReadonlyMap<string, MetricPoint>,
): DimensionResult {
  if (dimension.inputs.length === 0) return dimension
  const extra: SourceRef[] = []
  const seen = new Set<string>()
  for (const ref of dimension.inputs) {
    if (!ref.entityId) continue
    const key = `${ref.entityId}|${ref.metric}|${ref.observedOn}`
    if (seen.has(key)) continue
    seen.add(key)
    const point = lookup.get(key)
    for (const value of point?.values.slice(1) ?? []) {
      extra.push({
        metric: ref.metric,
        entityId: ref.entityId,
        observedOn: ref.observedOn,
        value: value.value,
        sourceId: value.sourceId,
        method: value.method,
        fetchedAt: value.fetchedAt.toISOString(),
      })
    }
  }
  return extra.length === 0 ? dimension : { ...dimension, inputs: [...dimension.inputs, ...extra] }
}

function riskInputs(ctx: WorkspaceContext, marketplace: string) {
  const brands: RiskBrand[] = ctx.brands
    .filter((b) => b.marketplace === null || b.marketplace === marketplace)
    .map((b) => ({ brand: b.name, kind: b.kind }))
  const rules: RiskRuleInput[] = ctx.rules.map((r) => ({
    type: r.kind,
    match: {
      ...(r.match.platform ? { platform: r.match.platform } : {}),
      ...(r.match.categoryIds ? { categoryIds: r.match.categoryIds } : {}),
      ...(r.match.attributes ? { attributes: r.match.attributes } : {}),
    },
    level: r.level,
    note: r.description,
    veto: r.veto,
  }))
  return { brands, rules }
}

/** 簇的风险取风险最高的成员（合规分最低，相同时发现更多的） */
function clusterRisk(
  ctx: WorkspaceContext,
  platform: Platform,
  marketplace: string,
  products: readonly MarketProduct[],
): RiskResult {
  const { brands, rules } = riskInputs(ctx, marketplace)
  const sellers = new Set(products.map((p) => p.sellerId).filter(Boolean))
  let worst: RiskResult | null = null
  for (const product of products) {
    const result = checkRisks({
      product: {
        platform,
        brand: product.brand,
        title: product.title ?? '',
        categoryId: product.categoryId,
        mainSellerCount: sellers.size,
      },
      mode: FOLLOW_MODE,
      brands,
      rules,
    })
    if (
      !worst ||
      result.complianceScore < worst.complianceScore ||
      (result.complianceScore === worst.complianceScore &&
        result.findings.length > worst.findings.length)
    )
      worst = result
  }
  return worst as RiskResult
}

/**
 * 合规维度直接采用 packages/risk 的合规分（其扣分与“只有 veto 才否决”的规则见 blockers D2），
 * 来源引用与理由沿用 selection 的 compliance()。
 */
function complianceDimension(asOf: string, risk: RiskResult): DimensionResult {
  const scored = risk.findings.filter(
    (f): f is typeof f & { level: 'high' | 'medium' | 'low' } => f.level !== 'info',
  )
  const base = compliance({
    asOf,
    findings: scored.map((f) => ({ type: f.type, level: f.level, veto: f.veto, basis: f.basis })),
  })
  const veto = risk.findings.some((f) => f.veto)
  return {
    ...base,
    score: risk.complianceScore,
    reason:
      scored.length === 0
        ? '未发现风险'
        : `${veto ? '一票否决：' : '风险扣分：'}${scored.map((f) => f.basis).join('；')}`,
    detail: { veto },
  }
}

interface ClusterInput {
  readonly row: Direction
  readonly clusterId: string
  readonly marketplace: string
  readonly platform: Platform
  readonly products: readonly MarketProduct[]
  readonly memberConfidences: readonly number[]
  readonly series: MetricSeriesMap
  readonly benchmark: readonly string[]
  readonly timing: NodeTiming | null
  readonly trend: Trend | null
}

async function evaluateCluster(ctx: WorkspaceContext, input: ClusterInput) {
  const { asOf } = ctx
  const { products, series, platform } = input
  const lookup = new Map<string, MetricPoint>()
  for (const p of products) {
    for (const [metric, points] of series.get(p.id) ?? []) {
      for (const point of points) lookup.set(`${p.id}|${metric}|${point.observedOn}`, point)
    }
  }
  if (input.trend) {
    for (const point of input.trend.raw)
      lookup.set(`${input.trend.keyword}|search_trend_index|${point.observedOn}`, point)
  }
  const prices = memberSeries(products, series, 'price')
  const listings: ListingSighting[] = products.flatMap((p) =>
    p.sellerId
      ? [
          {
            entityId: p.id,
            sellerId: p.sellerId,
            firstSeenOn: day(p.listedAt ?? p.firstSeenAt),
            sourceId: CATALOG_SOURCE,
            method: p.listedAt ? ('official' as const) : ('derived' as const),
            fetchedAt: p.firstSeenAt.toISOString(),
          },
        ]
      : [],
  )
  const risk = clusterRisk(ctx, platform, input.marketplace, products)

  const dimensions: DimensionResult[] = [
    marketDemand({
      platform,
      asOf,
      soldQuantityTotal: memberSeries(products, series, 'sold_quantity_total'),
      salesEstimateMonthly: memberSeries(products, series, 'sales_estimate_monthly'),
      bsr: memberSeries(products, series, 'bsr'),
    }),
    growthSeason({
      asOf,
      keyword: input.trend?.keyword,
      trend: input.trend?.points ?? [],
      targetMonths: input.timing?.targetMonths,
    }),
    peerSpread({ asOf, benchmarkSellerIds: input.benchmark, listings }),
    // M3 核算前没有落地成本，利润维度为空
    profit({ platform, asOf, prices, landedCosts: null }),
    competition({
      asOf,
      sellerCount: clusterSellerCount(products, series),
      prices,
      reviewCounts: memberSeries(products, series, 'review_count'),
    }),
    supplyTiming({ asOf, platform, salesStart: input.timing?.salesStart ?? null }),
    complianceDimension(asOf, risk),
  ].map((d) => withAlternates(d, lookup))

  const days = new Set<string>()
  for (const p of products) {
    for (const points of series.get(p.id)?.values() ?? []) {
      for (const point of points)
        if (diffDays(point.observedOn, asOf) <= COVERAGE_WINDOW_DAYS) days.add(point.observedOn)
    }
  }
  const confidence = computeConfidence({
    now: ctx.now.toISOString(),
    dimensions,
    coverage: {
      snapshotDays: days.size,
      memberCount: products.length,
      sellerCount: new Set(products.map((p) => p.sellerId).filter(Boolean)).size,
    },
    memberConfidences: input.memberConfidences,
    readiness: READINESS,
  })
  const evaluation = evaluateLead(dimensions, READINESS, ctx.settings)
  const score = evaluation.composite.score === null ? null : round2(evaluation.composite.score)
  const deadline = dimensions.find((d) => d.dimension === 'supply-timing')?.detail?.deadline

  await scoped(ctx.db, ctx.workspaceId).transaction(async (tx) => {
    // 信号：簇 × 日期 × 维度
    await tx
      .insert(
        clusterSignal,
        dimensions.map((d) => ({
          clusterId: input.clusterId,
          observedOn: asOf,
          dimension: d.dimension as SelectionDimension,
          score: d.score === null ? null : round2(d.score),
          inputs: { reason: d.reason, refs: d.inputs, detail: d.detail ?? {} },
          computedAt: ctx.now,
        })),
      )
      .onConflictDoUpdate({
        target: [clusterSignal.clusterId, clusterSignal.observedOn, clusterSignal.dimension],
        set: {
          score: sqlExcluded('score'),
          inputs: sqlExcluded('inputs'),
          computedAt: sqlExcluded('computed_at'),
        },
      })

    // 风险发现是簇的当前状态：整体替换
    await tx.delete(riskFinding, eq(riskFinding.clusterId, input.clusterId))
    const findings = new Map<string, (typeof risk.findings)[number]>()
    for (const f of risk.findings) findings.set(`${f.type}|${f.basis}`, f)
    if (findings.size > 0) {
      await tx.insert(
        riskFinding,
        [...findings.values()].map((f) => ({
          clusterId: input.clusterId,
          kind: f.type,
          ref: f.basis,
          level: f.level,
          evidence: { basis: f.basis, ...(f.link ? { link: f.link } : {}) },
          veto: f.veto,
          detectedAt: ctx.now,
        })),
      )
    }

    // 线索：簇 × 日期唯一；新线索沿用该簇上一条线索的处理状态，重复运行不改团队设置的状态
    const [previous] = await tx
      .select(lead, {
        where: and(eq(lead.clusterId, input.clusterId), lt(lead.leadOn, asOf)) as SQL,
      })
      .orderBy(desc(lead.leadOn))
      .limit(1)
    const values = {
      score,
      grade: evaluation.grade === null ? null : GRADE_TO_DB[evaluation.grade],
      confidence: confidence.value,
      confidenceDetail: {
        level: confidence.level,
        items: confidence.items,
        unverifiedMetrics: confidence.unverifiedMetrics,
        readiness: READINESS,
        displayGrade: evaluation.displayGrade,
        rankKey: rankKey(evaluation.composite.score, confidence.value),
        attention: needsAttention(evaluation.composite.score, confidence.level),
        used: evaluation.composite.used,
        missing: evaluation.composite.missing,
      },
      gates: { passed: evaluation.gates.passed, failures: evaluation.gates.failures },
      vetoed: !evaluation.gates.passed,
      latestDecisionOn: typeof deadline === 'string' ? deadline : null,
      settingVersion: evaluation.settingsVersion,
    }
    await tx
      .insert(lead, {
        clusterId: input.clusterId,
        directionId: input.row.id,
        leadOn: asOf,
        status: previous?.status ?? 'new',
        ...values,
      })
      .onConflictDoUpdate({
        target: [lead.clusterId, lead.leadOn],
        set: { ...values, updatedAt: ctx.now },
      })
  })
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`)
