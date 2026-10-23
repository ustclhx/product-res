import type { Marketplace, NormalizedObservation } from '@product-res/datasources'
import {
  clusterMember,
  type Database,
  lead,
  marketplaceProduct,
  type StoreListing,
  scoped,
  storeListing,
  type TrackedStore,
  trackedProduct,
  trackedStore,
} from '@product-res/db'
import {
  listTrackedProducts,
  type MetricSeriesMap,
  readMetricSeries,
  setTrackedProductTier,
  trackProduct,
  upsertEntities,
  upsertObservations,
} from '@product-res/marketdata'
import { addDays, diffDays } from '@product-res/selection'
import { log } from '@product-res/shared/log'
import { and, desc, eq, gte, inArray, ne, or, type SQL } from 'drizzle-orm'
import { createStoreSaleLead, storeLeadProducts } from './leads.ts'
import {
  computeStoreMetrics,
  type DayValue,
  decideTier,
  lastChangeOn,
  orderEnrollment,
  roseWithin,
  type SaleSignal,
  STORE_TRACKING_DEFAULTS,
  type StoreListingFacts,
  type StoreMetrics,
  type StoreTrackingSettings,
  saleSignal,
  type TierUpReason,
} from './rules.ts'

/**
 * 店铺追踪的每日评估（design D5、D6）：在已采集的数据上
 * 1. 计算店铺新品的出单信号，上架 30 天内首次出单的生成“店铺新品出单”线索（同商品去重）；
 * 2. 把店铺新品与线索商品加入被追踪商品（上限默认 100），按信号升档、30 天无变化降档并记录原因；
 * 3. 计算店铺指标写入观测（卖家实体、T4 推算），样本不足的指标不写。
 * 采集任务的生成见 collect.ts；评估只读写数据库，不调用外部接口。
 */

export const STORE_METRICS_SOURCE = 'store-tracking'

/** 读取的指标与回看天数 */
const SERIES_METRICS = ['bought_month', 'sold_quantity_total', 'available_quantity', 'review_count']
const LOOKBACK_DAYS = 150

const platformOf = (marketplace: string) => marketplace.split('-')[0] as 'ebay' | 'amazon'
const isoDay = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 10) : null)

export interface ListingView {
  readonly listing: StoreListing
  readonly productId: string
  readonly marketplace: string
  readonly platformId: string
  readonly title: string | null
  readonly url: string | null
  readonly imageUrl: string | null
  readonly categoryId: string | null
  /** 上架日（Amazon Date First Available / eBay itemCreationDate）；未知为 null */
  readonly listedOn: string | null
  /**
   * 是否店铺新品：发现时上架不超过 30 天。Amazon 尚未取得上架日时为 null（待确认，
   * 先加入追踪，快照取得上架日后再判断）。
   */
  readonly isNew: boolean | null
  /** 计算“上架 30 天内”的起点：上架日，eBay 缺失时退回首次发现日 */
  readonly baseOn: string | null
  readonly signal: SaleSignal | null
  /** 最新 bought 区间（Amazon）或自发现以来的已售增量（eBay） */
  readonly sales: { readonly low: number; readonly high: number | null } | null
}

export type ListingRow = StoreListing & {
  readonly marketplace: string
  readonly platformId: string
  readonly title: string | null
  readonly url: string | null
  readonly imageUrl: string | null
  readonly categoryId: string | null
  readonly listedAt: Date | null
}

/** 店铺 × 商品记录与商品信息（部署级），首次发现日新到旧 */
export async function loadListings(
  db: Database,
  stores: readonly Pick<TrackedStore, 'platform' | 'marketplace' | 'sellerKey'>[],
): Promise<ListingRow[]> {
  if (stores.length === 0) return []
  const unique = [...new Map(stores.map((s) => [`${s.platform}|${s.sellerKey}`, s])).values()]
  const rows = await db
    .select({
      listing: storeListing,
      marketplace: marketplaceProduct.marketplace,
      platformId: marketplaceProduct.platformId,
      title: marketplaceProduct.title,
      url: marketplaceProduct.url,
      imageUrl: marketplaceProduct.imageUrl,
      categoryId: marketplaceProduct.categoryId,
      listedAt: marketplaceProduct.listedAt,
    })
    .from(storeListing)
    .innerJoin(marketplaceProduct, eq(marketplaceProduct.id, storeListing.productId))
    .where(
      or(
        ...unique.map(
          (s) =>
            and(
              eq(storeListing.platform, s.platform),
              eq(storeListing.sellerKey, s.sellerKey),
            ) as SQL,
        ),
      ),
    )
    .orderBy(desc(storeListing.firstSeenOn))
  // 同一卖家 ID 在不同站点各自记录：按店铺的站点过滤
  const markets = new Set(stores.map((s) => `${s.marketplace}|${s.sellerKey}`))
  return rows
    .filter((r) => markets.has(`${r.marketplace}|${r.listing.sellerKey}`))
    .map(({ listing, ...product }) => ({ ...listing, ...product }))
}

/** 按站点分组读取序列（来源优先级按站点取） */
export async function readSeriesByMarketplace(
  db: Database,
  products: readonly { id: string; marketplace: string }[],
  from: string,
  to: string,
): Promise<MetricSeriesMap> {
  const out: MetricSeriesMap = new Map()
  const groups = new Map<string, string[]>()
  for (const p of products) groups.set(p.marketplace, [...(groups.get(p.marketplace) ?? []), p.id])
  for (const [marketplace, ids] of groups) {
    const series = await readMetricSeries(db, {
      entityType: 'product',
      entityIds: ids,
      metrics: SERIES_METRICS,
      marketplace: marketplace as Marketplace,
      from,
      to,
    })
    for (const [id, metrics] of series) out.set(id, metrics)
  }
  return out
}

const valuesOf = (series: MetricSeriesMap, productId: string, metric: string): DayValue[] =>
  (series.get(productId)?.get(metric) ?? []).map((p) => ({
    observedOn: p.observedOn,
    // 区间型（bought）按下界比较升降
    value: p.primary.valueLow ?? p.primary.value,
  }))

function boughtPoints(series: MetricSeriesMap, productId: string) {
  return (series.get(productId)?.get('bought_month') ?? [])
    .filter((p) => p.primary.valueLow !== null)
    .map((p) => ({
      observedOn: p.observedOn,
      low: p.primary.valueLow as number,
      high: p.primary.valueHigh,
    }))
}

/** 商品记录 → 店铺新品视图（出单信号、上架日、最新出单区间） */
export function toListingViews(
  rows: readonly ListingRow[],
  series: MetricSeriesMap,
  settings: Pick<
    StoreTrackingSettings,
    'newListingDays' | 'boughtSignalLow' | 'soldSignalDelta'
  > = STORE_TRACKING_DEFAULTS,
): ListingView[] {
  return rows.map((row) => {
    const platform = platformOf(row.marketplace)
    const listedOn = isoDay(row.listedAt)
    const baseOn = listedOn ?? (platform === 'ebay' ? row.firstSeenOn : null)
    const isNew =
      baseOn === null ? null : diffDays(baseOn, row.firstSeenOn) <= settings.newListingDays
    const bought = boughtPoints(series, row.productId)
    const sold = valuesOf(series, row.productId, 'sold_quantity_total')
    const signal = saleSignal(
      {
        platform,
        firstSeenOn: row.firstSeenOn,
        bought,
        sold,
        available: valuesOf(series, row.productId, 'available_quantity'),
      },
      settings,
    )
    let sales: ListingView['sales'] = null
    const latestBought = bought.at(-1)
    if (platform === 'amazon' && latestBought)
      sales = { low: latestBought.low, high: latestBought.high }
    else if (platform === 'ebay' && sold.length > 0) {
      const base = sold.filter((p) => p.observedOn <= row.firstSeenOn).at(-1) ?? sold[0]
      sales = {
        low: Math.max(0, (sold.at(-1) as DayValue).value - (base as DayValue).value),
        high: null,
      }
    }
    return {
      listing: row,
      productId: row.productId,
      marketplace: row.marketplace,
      platformId: row.platformId,
      title: row.title,
      url: row.url,
      imageUrl: row.imageUrl,
      categoryId: row.categoryId,
      listedOn,
      isNew,
      baseOn,
      signal,
      sales,
    }
  })
}

/** 店铺新品（已确认的新品）→ 指标输入；起点用上架日 */
export function metricsOf(
  views: readonly ListingView[],
  today: string,
  settings: StoreTrackingSettings = { ...STORE_TRACKING_DEFAULTS },
): StoreMetrics {
  const facts: StoreListingFacts[] = views
    .filter((v) => v.isNew === true && v.baseOn !== null)
    .map((v) => ({
      productId: v.productId,
      firstSeenOn: v.baseOn as string,
      delistedOn: v.listing.delistedOn,
      categoryId: v.categoryId,
      signalOn: v.signal?.on ?? null,
      sales: v.sales,
    }))
  return computeStoreMetrics(facts, today, settings)
}

/** 有追踪中店铺或被追踪商品的空间（系统任务跨空间列出，之后经 scoped() 读取） */
async function trackingWorkspaces(db: Database) {
  const [stores, products] = await Promise.all([
    db
      .selectDistinct({ workspaceId: trackedStore.workspaceId })
      .from(trackedStore)
      .where(eq(trackedStore.status, 'active')),
    db.selectDistinct({ workspaceId: trackedProduct.workspaceId }).from(trackedProduct),
  ])
  return [...new Set([...stores, ...products].map((r) => r.workspaceId))]
}

export interface WorkspaceEvaluation {
  readonly workspaceId: string
  readonly enrolled: number
  /** 因达到上限未加入的商品数 */
  readonly overCap: number
  readonly tierChanges: number
  readonly leads: number
  /** 没有覆盖该站点的启用方向而未生成的线索 */
  readonly leadsWithoutDirection: number
}

export interface StoreEvaluationResult {
  readonly day: string
  readonly workspaces: readonly WorkspaceEvaluation[]
  readonly metricsWritten: number
  readonly failures: readonly { workspaceId: string; error: string }[]
}

/** 本空间线索商品：近 30 天未放弃线索所在簇的成员，按线索日新到旧；附带最新线索的创建时间 */
async function leadProducts(db: Database, workspaceId: string, day: string) {
  const s = scoped(db, workspaceId)
  const leads = await s
    .select(lead, {
      fields: { clusterId: lead.clusterId, createdAt: lead.createdAt },
      where: and(ne(lead.status, 'dropped'), gte(lead.leadOn, addDays(day, -30))) as SQL,
    })
    .orderBy(desc(lead.leadOn))
  if (leads.length === 0) return new Map<string, Date>()
  const latest = new Map<string, Date>()
  for (const l of leads) {
    const seen = latest.get(l.clusterId)
    if (!seen || l.createdAt > seen) latest.set(l.clusterId, l.createdAt)
  }
  const members = await s.select(clusterMember, {
    fields: { clusterId: clusterMember.clusterId, productId: clusterMember.productId },
    where: inArray(clusterMember.clusterId, [...latest.keys()]),
  })
  const out = new Map<string, Date>()
  for (const m of members) {
    const at = latest.get(m.clusterId) as Date
    const seen = out.get(m.productId)
    if (!seen || at > seen) out.set(m.productId, at)
  }
  return out
}

async function evaluateWorkspace(
  db: Database,
  workspaceId: string,
  input: {
    readonly day: string
    readonly now: Date
    readonly settings: StoreTrackingSettings
    readonly views: Map<string, ListingView[]>
  },
): Promise<WorkspaceEvaluation> {
  const { day, now, settings } = input
  const s = scoped(db, workspaceId)
  const stores = await s.select(trackedStore, { where: eq(trackedStore.status, 'active') })
  const storeViews = stores.map((store) => ({
    store,
    views: input.views.get(`${store.marketplace}|${store.sellerKey}`) ?? [],
  }))

  // 1. 店铺新品出单线索：上架 30 天内首次出单，同一商品只生成一次
  const already = await storeLeadProducts(db, workspaceId)
  let leads = 0
  let leadsWithoutDirection = 0
  const signaled = new Set<string>()
  for (const { store, views } of storeViews) {
    for (const v of views) {
      if (!v.signal || v.isNew !== true || v.baseOn === null) continue
      if (diffDays(v.baseOn, v.signal.on) > settings.newListingDays) continue
      if (diffDays(v.signal.on, day) <= settings.risingDays) signaled.add(v.productId)
      if (already.has(v.productId)) continue
      const outcome = await createStoreSaleLead(db, workspaceId, {
        productId: v.productId,
        store,
        signal: v.signal,
        firstSeenOn: v.listing.firstSeenOn,
        day,
      })
      if (outcome.status === 'created') {
        leads++
        already.add(v.productId)
        signaled.add(v.productId)
      } else if (outcome.status === 'no-direction') leadsWithoutDirection++
    }
  }

  // 2. 加入追踪：店铺新品（含待确认的 Amazon 新品）店铺内新到旧、店铺间轮询并先给每店保底，
  //    其次线索商品；总数不超过上限（规则见 rules.ts orderEnrollment）
  const tracked = await listTrackedProducts(db, workspaceId)
  const trackedIds = new Set(tracked.map((t) => t.productId))
  const fromLeads = await leadProducts(db, workspaceId, day)
  let room = Math.max(0, settings.productCap - trackedIds.size)
  const candidates = orderEnrollment({
    stores: storeViews.map(({ store, views }) => ({
      storeId: store.id,
      items: views
        .filter((v) => v.isNew !== false && !v.listing.delistedOn)
        .map((v) => ({
          productId: v.productId,
          firstSeenOn: v.listing.firstSeenOn,
          listedOn: v.listedOn,
        })),
    })),
    leads: [...fromLeads.keys()],
    tracked: trackedIds,
    room,
  })
  let enrolled = 0
  let overCap = 0
  for (const c of candidates) {
    if (trackedIds.has(c.productId)) continue
    if (room <= 0) {
      overCap++
      continue
    }
    const hot = signaled.has(c.productId) || c.origin === 'lead'
    const { created } = await trackProduct(db, workspaceId, {
      productId: c.productId,
      origin: c.origin,
      originRef: c.originRef,
      tier: hot ? 'hot' : 'normal',
      reason: hot ? (c.origin === 'lead' ? 'new-lead' : 'sale-signal') : `added:${c.origin}`,
    })
    trackedIds.add(c.productId)
    if (created) {
      enrolled++
      room--
    }
  }
  if (overCap > 0)
    log.info('stores.tracking_cap_reached', { workspaceId, overCap, cap: settings.productCap })

  // 3. 升降档
  const rows = await listTrackedProducts(db, workspaceId)
  const products =
    rows.length === 0
      ? []
      : await db
          .select({ id: marketplaceProduct.id, marketplace: marketplaceProduct.marketplace })
          .from(marketplaceProduct)
          .where(
            inArray(
              marketplaceProduct.id,
              rows.map((r) => r.productId),
            ),
          )
  const series = await readSeriesByMarketplace(db, products, addDays(day, -60), day)
  let tierChanges = 0
  for (const row of rows) {
    const up = new Set<TierUpReason>()
    if (signaled.has(row.productId)) up.add('sale-signal')
    const leadAt = fromLeads.get(row.productId)
    if (leadAt && leadAt > row.tierChangedAt) up.add('new-lead')
    if (roseWithin(valuesOf(series, row.productId, 'bought_month'), day, settings.risingDays))
      up.add('bought-up')
    if (
      roseWithin(valuesOf(series, row.productId, 'sold_quantity_total'), day, settings.risingDays)
    )
      up.add('sold-up')
    const decision = decideTier(
      {
        tier: row.tier,
        tierChangedOn: isoDay(row.tierChangedAt) as string,
        up,
        lastChangeOn: lastChangeOn(
          ['bought_month', 'sold_quantity_total', 'review_count'].map((m) =>
            valuesOf(series, row.productId, m),
          ),
        ),
        today: day,
      },
      settings,
    )
    if (!decision) continue
    const changed = await setTrackedProductTier(db, workspaceId, {
      productId: row.productId,
      tier: decision.tier,
      reason: decision.reason,
      now,
    })
    if (changed) tierChanges++
  }
  return { workspaceId, enrolled, overCap, tierChanges, leads, leadsWithoutDirection }
}

const METRIC_NAMES = {
  newPerWeek: 'store_new_per_week',
  survivalRate: 'store_survival_rate',
  hitRate: 'store_hit_rate',
  salesSum: 'store_sales_sum',
  directionShift: 'store_direction_shift',
} as const

/** 店铺指标 → 卖家实体的 T4 观测；为 null 的指标不写 */
export function metricObservations(
  key: { marketplace: string; sellerKey: string },
  metrics: StoreMetrics,
  day: string,
): NormalizedObservation[] {
  const entity = {
    type: 'seller' as const,
    marketplace: key.marketplace as Marketplace,
    platformId: key.sellerKey,
  }
  const base = { entity, observedOn: day, method: 'derived' as const, tier: 4 as const }
  const out: NormalizedObservation[] = []
  for (const name of ['newPerWeek', 'survivalRate', 'hitRate', 'directionShift'] as const) {
    const value = metrics[name]
    if (value !== null) out.push({ ...base, metric: METRIC_NAMES[name], value })
  }
  if (metrics.salesSum)
    out.push({
      ...base,
      metric: METRIC_NAMES.salesSum,
      value: metrics.salesSum.low,
      valueLow: metrics.salesSum.low,
      valueHigh: metrics.salesSum.high,
    })
  return out
}

/**
 * 每日评估入口。workspaceId 给出时只评估该空间（手动触发）；店铺指标按涉及的店铺写入（部署级）。
 */
export async function evaluateStoreTracking(
  db: Database,
  options: {
    readonly day: string
    readonly now: Date
    readonly workspaceId?: string | undefined
    readonly settings?: Partial<StoreTrackingSettings> | undefined
  },
): Promise<StoreEvaluationResult> {
  const settings: StoreTrackingSettings = { ...STORE_TRACKING_DEFAULTS, ...options.settings }
  const { day, now } = options
  const workspaceIds = options.workspaceId ? [options.workspaceId] : await trackingWorkspaces(db)
  const storesByWorkspace = new Map<string, TrackedStore[]>()
  for (const id of workspaceIds)
    storesByWorkspace.set(
      id,
      await scoped(db, id).select(trackedStore, { where: eq(trackedStore.status, 'active') }),
    )
  const allStores = [...storesByWorkspace.values()].flat()
  const rows = await loadListings(db, allStores)
  const recent = rows.filter((r) => r.firstSeenOn >= addDays(day, -LOOKBACK_DAYS))
  const series = await readSeriesByMarketplace(
    db,
    recent.map((r) => ({ id: r.productId, marketplace: r.marketplace })),
    addDays(day, -LOOKBACK_DAYS),
    day,
  )
  const views = new Map<string, ListingView[]>()
  for (const v of toListingViews(recent, series, settings)) {
    const key = `${v.marketplace}|${v.listing.sellerKey}`
    views.set(key, [...(views.get(key) ?? []), v])
  }

  const results: WorkspaceEvaluation[] = []
  const failures: { workspaceId: string; error: string }[] = []
  for (const workspaceId of workspaceIds) {
    try {
      results.push(await evaluateWorkspace(db, workspaceId, { day, now, settings, views }))
    } catch (error) {
      failures.push({ workspaceId, error: error instanceof Error ? error.message : String(error) })
      log.error('stores.evaluate_failed', { workspaceId, error })
    }
  }

  // 店铺指标（部署级）：每个店铺（站点 × 卖家）一次
  const keys = new Map(allStores.map((s) => [`${s.marketplace}|${s.sellerKey}`, s]))
  const observations: NormalizedObservation[] = []
  for (const [key, store] of keys)
    observations.push(
      ...metricObservations(store, metricsOf(views.get(key) ?? [], day, settings), day),
    )
  let metricsWritten = 0
  if (observations.length > 0) {
    const ids = await upsertEntities(
      db,
      observations.map((o) => ({ key: o.entity })),
    )
    metricsWritten = await upsertObservations(db, observations, ids, {
      sourceId: STORE_METRICS_SOURCE,
      fetchedAt: now,
    })
  }
  return { day, workspaces: results, metricsWritten, failures }
}
