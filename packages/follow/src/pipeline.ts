import type { Marketplace } from '@product-res/datasources'
import {
  type BrandEntry,
  brandEntry,
  clusterMember,
  clusterSignal,
  cluster as clusterTable,
  costingScenario,
  type Database,
  type Direction,
  direction,
  directionSeller,
  lead,
  type ReadinessStat,
  type RiskRule,
  readinessStat,
  recommendation,
  riskFinding,
  riskRule,
  type Scoped,
  type SeasonalNode,
  type SelectionDimension,
  scoped,
  seasonalNode,
  transferringWorkspaceIds,
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
  type ConfidenceResult,
  type CostedProfit,
  type CostedTiming,
  competition,
  compliance,
  computeConfidence,
  type DimensionResult,
  diffDays,
  dominantDimension,
  evaluateLead,
  growthSeason,
  type HistoryHitRate,
  type LeadEvaluation,
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
import { and, desc, eq, inArray, lt, lte, type SQL, sql } from 'drizzle-orm'
import { GRADE_TO_DB, METHOD_FROM_DB, METHOD_TO_DB } from './mapping.ts'
import { currentScoringSetting, toScoringSettings } from './settings.ts'
import { mergedBenchmarks } from './stores/pool.ts'

/**
 * 跟卖选品每日流水线（design D7，tasks 3.1）：对每个空间的每个启用方向
 * 读取范围内的市场商品 → 归并为簇 → 7 维信号 → 风险 → 综合分、门槛、等级、置信度 → 写库。
 * 按 簇 × 日期 upsert，同一天重复运行不产生重复线索。
 */

/** 每日流水线的时区：日期按新加坡时间计 */
export const SELECTION_TIME_ZONE = 'Asia/Singapore'

/** 尚无准备度统计的组合按冷启动处理（只展示信号，不给等级） */
const COLD_START: Readiness = 'cold-start'

/** 跟卖方式取簇最新线索的 lead.follow_mode；还没有线索时按“同款同货源”检查风险（更严格） */
const DEFAULT_FOLLOW_MODE: FollowMode = 'same-source'
type FollowMode = 'same-source' | 'improved'

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
  options: RunOptions & {
    /** 只运行这些空间（测试与人工补跑用）；省略时运行所有有启用方向的空间 */
    readonly workspaceIds?: readonly string[] | undefined
  },
): Promise<WorkspaceRunResult[]> {
  const only = options.workspaceIds
  if (only && only.length === 0) return []
  // 系统任务需要跨空间列出“有启用方向的空间”；之后的读写都经 scoped() 限定在单个空间
  const workspaces = await db
    .selectDistinct({ workspaceId: direction.workspaceId })
    .from(direction)
    .where(
      only
        ? (and(eq(direction.enabled, true), inArray(direction.workspaceId, [...only])) as SQL)
        : eq(direction.enabled, true),
    )
  const results: WorkspaceRunResult[] = []
  const transferring = await transferringWorkspaceIds(db)
  for (const { workspaceId } of workspaces) {
    if (transferring.has(workspaceId)) continue
    try {
      results.push(
        await runSelectionForWorkspace(db, workspaceId, { now: options.now, asOf: options.asOf }),
      )
    } catch (error) {
      log.error('selection.workspace_failed', { workspaceId, error })
    }
  }
  return results
}

export interface WorkspaceContext {
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
  /** 站点 | 方向 | 信号类型 → 最新一次准备度统计 */
  readonly readiness: ReadonlyMap<string, ReadinessStat>
}

export const readinessKey = (marketplace: string, directionId: string, signalType: string) =>
  `${marketplace}|${directionId}|${signalType}`

/** 每个 站点 × 方向 × 信号类型 的最新准备度统计（按计算日取最新一条） */
export async function latestReadiness(
  db: Database,
  workspaceId: string,
): Promise<Map<string, ReadinessStat>> {
  const rows = await scoped(db, workspaceId)
    .select(readinessStat)
    .orderBy(desc(readinessStat.computedOn))
  const out = new Map<string, ReadinessStat>()
  for (const row of rows) {
    const key = readinessKey(row.marketplace, row.directionId, row.signalType)
    if (!out.has(key)) out.set(key, row)
  }
  return out
}

/** 读取一个空间的评分设置、风险词库、节点、对标店铺与准备度（流水线与回放共用） */
export async function loadWorkspaceContext(
  db: Database,
  workspaceId: string,
  options: RunOptions,
): Promise<WorkspaceContext> {
  const s = scoped(db, workspaceId)
  const settings = toScoringSettings(await currentScoringSetting(db, workspaceId))
  const [brands, rules, nodes, sellers, readiness] = await Promise.all([
    s.select(brandEntry),
    s.select(riskRule, { where: eq(riskRule.enabled, true) }),
    s.select(seasonalNode),
    s.select(directionSeller, {
      where: inArray(directionSeller.status, ['seed', 'accepted']),
    }),
    latestReadiness(db, workspaceId),
  ])
  const benchmarks = new Map<string, { marketplace: string; sellerId: string }[]>()
  for (const seller of sellers) {
    const list = benchmarks.get(seller.directionId) ?? []
    list.push({ marketplace: seller.marketplace, sellerId: seller.sellerPlatformId })
    benchmarks.set(seller.directionId, list)
  }
  // 店铺池中关联到方向的店铺与方向的对标店铺合并（读取时合并，不迁移；同一店铺只计一次）
  for (const [directionId, stores] of await mergedBenchmarks(db, workspaceId)) {
    const list = benchmarks.get(directionId) ?? []
    for (const store of stores)
      if (!list.some((b) => b.marketplace === store.marketplace && b.sellerId === store.sellerId))
        list.push(store)
    benchmarks.set(directionId, list)
  }
  return {
    db,
    workspaceId,
    asOf: options.asOf ?? localDay(options.now),
    now: options.now,
    settings,
    brands,
    rules,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    benchmarks,
    readiness,
  }
}

/** 运行一个空间的全部启用方向（也供人工刷新使用） */
export async function runSelectionForWorkspace(
  db: Database,
  workspaceId: string,
  options: RunOptions,
): Promise<WorkspaceRunResult> {
  const directions = await scoped(db, workspaceId)
    .select(direction, { where: eq(direction.enabled, true) })
    .orderBy(direction.createdAt)
  const context = await loadWorkspaceContext(db, workspaceId, options)
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

/** 簇在计算日之前（含当日）的核算状态：最新线索的跟卖方式与可用的核算组合 */
export interface ClusterCosting {
  readonly followMode: FollowMode
  readonly profit: CostedProfit | null
  readonly timing: CostedTiming | null
  /** 核算组合的成本确定性（packages/costing certainty，矩阵计算时写入快照） */
  readonly certainty: number | null
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown) => (typeof v === 'string' && v ? v : null)

interface ParsedScenario {
  readonly id: string
  readonly selected: boolean
  readonly profit: CostedProfit
  readonly deadline: string | null
  readonly saleStart: string | null
  readonly certainty: number | null
}

/**
 * 解析 costing_scenario.result（apps/web 核算矩阵写入的 MatrixCell + inputs 快照）。
 * 只有带完整核算结果（status ok）的组合可用；缺输入的组合返回 null。
 */
function parseScenario(row: {
  id: string
  selected: boolean
  result: Record<string, unknown>
}): ParsedScenario | null {
  const cell = row.result
  const outcome = asRecord(cell.result)
  if (outcome?.status !== 'ok') return null
  const grossMargin = finite(outcome.grossMargin)
  const salePriceMinor = finite(outcome.salePriceMinor)
  const landedCostMinor = finite(outcome.landedCostMinor)
  const currency = text(outcome.currency)
  if (grossMargin === null || salePriceMinor === null || landedCostMinor === null || !currency)
    return null
  const inputs = asRecord(cell.inputs)
  const supplierName = text(asRecord(inputs?.quote)?.supplierName)
  const profileName = text(asRecord(inputs?.profile)?.name)
  const mode = cell.mode === 'improved' ? '微改良' : '同货源'
  const plan = [supplierName, profileName, mode].filter(Boolean).join(' · ')
  return {
    id: row.id,
    selected: row.selected,
    profit: {
      scenarioId: row.id,
      plan,
      currency,
      salePriceMinor,
      landedCostMinor,
      grossMargin,
      selected: row.selected,
    },
    deadline: text(cell.deadline),
    saleStart: text(asRecord(inputs?.node)?.saleStartDate),
    certainty: finite(cell.certainty),
  }
}

/**
 * 读取簇的核算状态（add-costing-decisions tasks 3.3）：
 * - 跟卖方式取计算日及之前最新一条线索的 follow_mode；
 * - 核算组合取最近一条有可用组合的线索：选定组合优先，否则取毛利率最高的可计算组合。
 *   核算中 / 待决定的簇的新线索会带上上一条的组合，但计算发生在写入当日线索之前，
 *   且已决定的簇不复制，所以仍向前找，否则核算次日维度又会变空。
 */
export async function loadClusterCosting(
  ctx: WorkspaceContext,
  clusterIds: readonly string[],
): Promise<Map<string, ClusterCosting>> {
  const out = new Map<string, ClusterCosting>()
  if (clusterIds.length === 0) return out
  const s = scoped(ctx.db, ctx.workspaceId)
  const leads = await s
    .select(lead, {
      where: and(inArray(lead.clusterId, [...clusterIds]), lte(lead.leadOn, ctx.asOf)) as SQL,
      fields: { id: lead.id, clusterId: lead.clusterId, followMode: lead.followMode },
    })
    .orderBy(desc(lead.leadOn))
  if (leads.length === 0) return out
  const scenarios = await s.select(costingScenario, {
    where: inArray(
      costingScenario.leadId,
      leads.map((l) => l.id),
    ),
    fields: {
      id: costingScenario.id,
      leadId: costingScenario.leadId,
      selected: costingScenario.selected,
      result: costingScenario.result,
    },
  })
  const byLead = new Map<string, ParsedScenario[]>()
  for (const row of scenarios) {
    const parsed = parseScenario(row)
    if (parsed) byLead.set(row.leadId, [...(byLead.get(row.leadId) ?? []), parsed])
  }
  for (const l of leads) {
    const current = out.get(l.clusterId)
    if (current?.profit) continue
    const options = byLead.get(l.id) ?? []
    const pick =
      options.find((o) => o.selected) ??
      [...options].sort((a, b) => b.profit.grossMargin - a.profit.grossMargin)[0]
    // 跟卖方式只取最新一条线索；核算组合继续向前找
    const followMode = current?.followMode ?? l.followMode
    if (!pick) {
      if (!current)
        out.set(l.clusterId, { followMode, profit: null, timing: null, certainty: null })
      continue
    }
    out.set(l.clusterId, {
      followMode,
      profit: pick.profit,
      timing: pick.deadline
        ? {
            scenarioId: pick.id,
            plan: pick.profit.plan,
            deadline: pick.deadline,
            leadDays: pick.saleStart ? Math.max(0, diffDays(pick.deadline, pick.saleStart)) : 0,
          }
        : null,
      certainty: pick.certainty,
    })
  }
  return out
}

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
  const costing = await loadClusterCosting(
    ctx,
    active.map((c) => c.id),
  )
  const inputs = await clusterInputs(ctx, row, active, allMembers, products, costing)
  for (const input of inputs) await evaluateCluster(ctx, input)
  const leads = inputs.length
  return {
    directionId: row.id,
    clusters: active.length,
    createdClusters: assigned.createdClusterIds.length,
    leads,
  }
}

/**
 * 为一组簇准备计算输入：成员商品、指标序列（截至 ctx.asOf）、目标节点与搜索趋势。
 * 回放复用此函数，只需把 ctx.asOf 设为回放日；回放不传核算状态（历史日没有当时的核算结果）。
 */
export async function clusterInputs(
  ctx: WorkspaceContext,
  row: Direction,
  clusters: readonly { id: string; marketplace: string }[],
  members: readonly { clusterId: string; productId: string; confidence: number }[],
  products: ReadonlyMap<string, MarketProduct>,
  costing?: ReadonlyMap<string, ClusterCosting>,
): Promise<ClusterInput[]> {
  const benchmark = ctx.benchmarks.get(row.id) ?? []
  const membersOf = new Map<string, (typeof members)[number][]>()
  for (const member of members) {
    membersOf.set(member.clusterId, [...(membersOf.get(member.clusterId) ?? []), member])
  }
  const series = await readProductSeries(ctx, clusters, members)
  const timing = targetNode(ctx, row)
  const trends = await readTrends(ctx, row, clusters)
  const out: ClusterInput[] = []
  for (const c of clusters) {
    const platform = platformOf(c.marketplace as Marketplace)
    const clusterMembers = membersOf.get(c.id) ?? []
    if (!platform || clusterMembers.length === 0) continue
    const memberProducts = clusterMembers
      .map((m) => products.get(m.productId))
      .filter((p): p is MarketProduct => p !== undefined)
    out.push({
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
      ...(costing ? { costing: costing.get(c.id) ?? null } : {}),
    })
  }
  return out
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
  mode: FollowMode,
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
      mode,
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

export interface ClusterInput {
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
  /**
   * 核算状态（tasks 3.3）；省略时（回放）利润与时效按 M2 默认处理、置信度不含成本确定性，
   * null 表示簇还没有线索或核算
   */
  readonly costing?: ClusterCosting | null
}

export interface ClusterEvaluation {
  readonly dimensions: readonly DimensionResult[]
  readonly risk: RiskResult
  readonly confidence: ConfidenceResult
  readonly evaluation: LeadEvaluation
  /** 综合分（两位小数）；不可算时为 null */
  readonly score: number | null
  /** 主导维度（信号类型）；没有可算维度时为 null */
  readonly signalType: SelectionDimension | null
  readonly readiness: Readiness
  /** 季节类打标签用：预测的高峰周（周一）；无节点或无趋势时为 null */
  readonly predictedPeakWeek: string | null
}

/** 所在周的周一 YYYY-MM-DD */
export function weekStart(on: string): string {
  const weekday = new Date(`${on}T00:00:00Z`).getUTCDay()
  return addDays(on, -((weekday + 6) % 7))
}

/**
 * 预测高峰周：目标销售窗口内搜索趋势季节轮廓最高的月份，取下一次该月 15 日所在周。
 * 没有趋势或节点时为 null。
 */
function predictPeakWeek(
  timing: NodeTiming | null,
  trend: Trend | null,
  asOf: string,
): string | null {
  if (!timing || !trend) return null
  const profile = new Map<number, number[]>()
  for (const point of trend.points) {
    if (point.observedOn > asOf) continue
    const month = Number(point.observedOn.slice(5, 7))
    profile.set(month, [...(profile.get(month) ?? []), point.value])
  }
  let best: number | null = null
  let bestValue = Number.NEGATIVE_INFINITY
  for (const month of timing.targetMonths) {
    const values = profile.get(month)
    if (!values || values.length === 0) continue
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    if (avg > bestValue) {
      best = month
      bestValue = avg
    }
  }
  if (best === null) return null
  return weekStart(nextOccurrence(best, 15, asOf))
}

/** 计算一个簇在 ctx.asOf 的 7 维信号、风险、综合分、等级与置信度（不写库） */
export function computeCluster(ctx: WorkspaceContext, input: ClusterInput): ClusterEvaluation {
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
  const costing = input.costing ?? null
  const risk = clusterRisk(
    ctx,
    platform,
    input.marketplace,
    products,
    costing?.followMode ?? DEFAULT_FOLLOW_MODE,
  )

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
    // 有核算组合时利润采用其毛利率（毛利门槛随之生效）；未核算时没有落地成本，利润为空
    profit({ platform, asOf, prices, landedCosts: null, costed: costing?.profit ?? null }),
    competition({
      asOf,
      sellerCount: clusterSellerCount(products, series),
      prices,
      reviewCounts: memberSeries(products, series, 'review_count'),
    }),
    supplyTiming({
      asOf,
      platform,
      salesStart: input.timing?.salesStart ?? null,
      costed: costing?.timing ?? null,
    }),
    complianceDimension(asOf, risk),
  ].map((d) => withAlternates(d, lookup))

  const days = new Set<string>()
  for (const p of products) {
    for (const points of series.get(p.id)?.values() ?? []) {
      for (const point of points)
        if (diffDays(point.observedOn, asOf) <= COVERAGE_WINDOW_DAYS) days.add(point.observedOn)
    }
  }

  // 准备度按 站点 × 方向 × 信号类型 查最新统计；没有统计时为冷启动、历史命中率“无样本”
  const signalType = dominantDimension(dimensions, ctx.settings) as SelectionDimension | null
  const stat =
    signalType === null
      ? undefined
      : ctx.readiness.get(readinessKey(input.marketplace, input.row.id, signalType))
  const readiness: Readiness = stat?.level ?? COLD_START
  const historyHitRate: HistoryHitRate = {
    effectiveSamples: stat?.effectiveSamples ?? 0,
    lowerBound: stat?.wilsonLower ?? null,
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
    readiness,
    historyHitRate,
    // 回放（未传核算状态）不计该项；流水线中未核算的簇该项为空
    ...(input.costing === undefined ? {} : { costCertainty: costing?.certainty ?? null }),
  })
  const evaluation = evaluateLead(dimensions, readiness, ctx.settings)
  const score = evaluation.composite.score === null ? null : round2(evaluation.composite.score)
  return {
    dimensions,
    risk,
    confidence,
    evaluation,
    score,
    signalType,
    readiness,
    predictedPeakWeek: predictPeakWeek(input.timing, input.trend, asOf),
  }
}

/** 冻结时保存的每维输入引用上限：趋势序列可能有上千个点，只留最近的若干条 */
const FROZEN_REFS_PER_DIMENSION = 40

/**
 * 推荐的输入引用快照（design D1「输入引用快照」）：每维分数、理由、所用观测（实体、指标、日期、来源）
 * 与成员商品。打标签按冻结时的成员计算，之后的拆分合并不影响回看。
 */
export function frozenInputs(
  input: ClusterInput,
  result: ClusterEvaluation,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const dimensions: Record<string, unknown> = {}
  for (const d of result.dimensions) {
    dimensions[d.dimension] = {
      score: d.score === null ? null : round2(d.score),
      reason: d.reason,
      sources: [...new Set(d.inputs.map((r) => r.sourceId))].sort(),
      refCount: d.inputs.length,
      refs: d.inputs.slice(-FROZEN_REFS_PER_DIMENSION).map((r) => ({
        metric: r.metric,
        entityId: r.entityId ?? null,
        observedOn: r.observedOn,
        sourceId: r.sourceId,
        fetchedAt: r.fetchedAt,
      })),
    }
  }
  return {
    clusterId: input.clusterId,
    members: input.products.map((p) => p.id),
    dimensions,
    readiness: result.readiness,
    displayGrade: result.evaluation.displayGrade,
    confidenceLevel: result.confidence.level,
    gates: result.evaluation.gates.failures.map((f) => f.gate),
    predictedPeakWeek: result.predictedPeakWeek,
    ...extra,
  }
}

async function evaluateCluster(ctx: WorkspaceContext, input: ClusterInput) {
  const { asOf } = ctx
  const result = computeCluster(ctx, input)
  const { dimensions, risk, confidence, evaluation, score, readiness } = result
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

    // 线索：簇 × 日期唯一；新线索沿用该簇上一条线索的处理状态与跟卖方式，重复运行不改团队设置的状态
    const [previous] = await tx
      .select(lead, {
        where: and(eq(lead.clusterId, input.clusterId), lt(lead.leadOn, asOf)) as SQL,
      })
      .orderBy(desc(lead.leadOn))
      .limit(1)
    // 同一天重跑时线索已存在，只更新分数，不重复复制核算
    const [existing] = await tx
      .select(lead, {
        where: and(eq(lead.clusterId, input.clusterId), eq(lead.leadOn, asOf)) as SQL,
        fields: { id: lead.id },
      })
      .limit(1)
    const values = {
      score,
      grade: evaluation.grade === null ? null : GRADE_TO_DB[evaluation.grade],
      confidence: confidence.value,
      confidenceDetail: {
        level: confidence.level,
        items: confidence.items,
        unverifiedMetrics: confidence.unverifiedMetrics,
        readiness,
        signalType: result.signalType,
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
    const [written] = await tx
      .insert(lead, {
        clusterId: input.clusterId,
        directionId: input.row.id,
        leadOn: asOf,
        status: previous?.status ?? 'new',
        // 跟卖方式与改良参数同样沿用，否则次日风险评估会退回同货源
        followMode: previous?.followMode ?? DEFAULT_FOLLOW_MODE,
        improvement: previous?.improvement ?? null,
        ...values,
      })
      .onConflictDoUpdate({
        target: [lead.clusterId, lead.leadOn],
        set: { ...values, updatedAt: ctx.now },
      })
      .returning({ id: lead.id })

    // 核算组合挂在具体线索上：核算中 / 待决定的簇换到新一天的线索时把组合（含选定标记与结果快照）
    // 一并带过去，使簇的最新线索始终持有当前核算状态，待决定队列与跟卖决定只看最新线索即可。
    // 已决定的簇只继承状态并保持锁定，决定与其组合留在原线索上，档案库按 decision 展示。
    if (!existing && written && previous && CARRIED_STATUSES.has(previous.status))
      await carryScenarios(tx, previous.id, written.id)

    // 流水线末步：冻结影子推荐（tasks 2.2）。线索 × 冻结日唯一，已冻结的不覆盖，
    // 所以同日重跑或之后改权重都不改变已冻结的分数与权重版本
    const frozen = freezeValues(input, result, 'shadow', { leadId: written?.id ?? null })
    if (frozen) {
      await tx
        .insert(recommendation, { ...frozen, leadId: written?.id ?? null, frozenOn: asOf })
        .onConflictDoNothing()
    }
  })
}

/** 新一天的线索需要带上核算组合的状态 */
const CARRIED_STATUSES: ReadonlySet<string> = new Set(['costing', 'pending'])

/**
 * 把上一条线索的核算组合复制到新线索；结果快照原样保留，并在 result.copiedFrom 记下来源，
 * 计算时间沿用原组合（不是重算）。新线索已有同键组合时不覆盖。
 */
async function carryScenarios(tx: Scoped, fromLeadId: string, toLeadId: string) {
  const rows = await tx.select(costingScenario, { where: eq(costingScenario.leadId, fromLeadId) })
  if (rows.length === 0) return 0
  const copied = await tx
    .insert(
      costingScenario,
      rows.map((r) => ({
        leadId: toLeadId,
        quoteId: r.quoteId,
        profileId: r.profileId,
        mode: r.mode,
        plannedQty: r.plannedQty,
        salePriceMinor: r.salePriceMinor,
        currency: r.currency,
        improvement: r.improvement,
        result: {
          ...r.result,
          copiedFrom: {
            leadId: fromLeadId,
            scenarioId: (asRecord(r.result.copiedFrom)?.scenarioId as string | undefined) ?? r.id,
          },
        },
        selected: r.selected,
        computedAt: r.computedAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: costingScenario.id })
  return copied.length
}

/**
 * 推荐行（不含 leadId、frozenOn）。综合分或主导维度不可算的簇没有可验证的推荐，返回 null。
 */
export function freezeValues(
  input: ClusterInput,
  result: ClusterEvaluation,
  sampleKind: 'shadow' | 'replay',
  extra: Record<string, unknown> = {},
) {
  const { score, signalType, evaluation, confidence } = result
  if (score === null || signalType === null || evaluation.grade === null) return null
  return {
    clusterId: input.clusterId,
    directionId: input.row.id,
    marketplace: input.marketplace,
    signalType,
    score,
    grade: GRADE_TO_DB[evaluation.grade],
    confidence: Math.round(confidence.value * 1000) / 1000,
    settingVersion: evaluation.settingsVersion,
    inputs: frozenInputs(input, result, extra),
    sampleKind,
  }
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`)
