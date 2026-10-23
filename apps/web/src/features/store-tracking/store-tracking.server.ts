import { resolveEbayStoreUsername } from '@product-res/connectors'
import { direction, jobMessage, scoped, syncRun, type TrackedStore } from '@product-res/db'
import {
  addStore,
  getStore,
  type ListingView,
  listStores,
  loadListings,
  localDay,
  metricsOf,
  parseStoreLink,
  readSeriesByMarketplace,
  SELECTION_TIME_ZONE,
  STORE_LINK_ERRORS,
  STORE_SOURCES,
  STORE_TRACKING_QUEUE,
  type StoreLinkResult,
  type StoreRoundMessage,
  type StoreSettingsInput,
  setStoreStatus,
  storeKeywords,
  storeRoundKey,
  type TrackedStoreStatus,
  toListingViews,
  updateStore,
} from '@product-res/follow'
import { credentialStatus, getSource, isPaused, listTrackedProducts } from '@product-res/marketdata'
import type { Capability, QueueProducer } from '@product-res/platform'
import { addDays } from '@product-res/selection'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { webConnectors, webSecrets } from '../data-center/registry.server.ts'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'

/**
 * 店铺追踪页面（add-accuracy-store-tracking design D8，tasks 3.4）：店铺池列表、粘贴链接添加、
 * 店铺详情（新品、档位、出单信号、店铺指标与覆盖率说明）。店铺池经 scoped() 读写；
 * 店铺新品与观测是部署级共享数据。写操作要求可写空间的 owner / admin。
 */

/** 页面读取的回看天数（出单信号与新品计数） */
const LOOKBACK_DAYS = 150

export type SourceState = 'ok' | 'not-configured' | 'disabled' | 'paused' | 'unregistered'

export interface StoreRowView {
  id: string
  platform: 'ebay' | 'amazon'
  marketplace: string
  sellerKey: string
  displayName: string
  url: string | null
  kind: TrackedStore['kind']
  status: TrackedStore['status']
  reason: string | null
  directionIds: string[]
  directionNames: string[]
  keywords: string[]
  /** 实际使用的搜索词（Amazon：自有或关联方向的关键词） */
  searchKeywords: string[]
  new7d: number
  new30d: number
  /** Amazon 待确认上架日的发现数 */
  pending: number
  hitRate: number | null
  lastSyncAt: string | null
  /** 发现来源的状态：eBay → ebay-browse，Amazon → dataforseo */
  source: SourceState
  createdAt: string
}

export interface ListingItem {
  productId: string
  platformId: string
  title: string | null
  url: string | null
  imageUrl: string | null
  firstSeenOn: string
  lastSeenOn: string
  delistedOn: string | null
  listedOn: string | null
  isNew: boolean | null
  discovery: 'browse-seller' | 'search-offer'
  tier: 'hot' | 'normal' | 'cold' | null
  tierReason: string | null
  signal: { on: string; kind: string; low: number; high: number | null } | null
  sales: { low: number; high: number | null } | null
}

async function sourceStates(db: WorkbenchActor['db'], now: Date) {
  const registry = webConnectors()
  const secret = await webSecrets()
  const out: Record<string, SourceState> = {}
  for (const sourceId of Object.values(STORE_SOURCES)) {
    const connector = registry.get(sourceId)
    if (!connector) {
      out[sourceId] = 'unregistered'
      continue
    }
    const row = await getSource(db, sourceId)
    out[sourceId] =
      credentialStatus(connector, secret, row) === 'missing'
        ? 'not-configured'
        : !row?.enabled
          ? 'disabled'
          : isPaused(row, now)
            ? 'paused'
            : 'ok'
  }
  return out
}

const sourceOf = (platform: string) =>
  platform === 'ebay' ? STORE_SOURCES.ebay : STORE_SOURCES.amazon

/** 店铺所需数据源：eBay 只靠 Browse；Amazon 发现靠 DataForSEO，热点交叉验证靠 SerpApi */
const REQUIRED_SOURCES: Readonly<Record<'ebay' | 'amazon', readonly string[]>> = {
  ebay: [STORE_SOURCES.ebay],
  amazon: [STORE_SOURCES.amazon, STORE_SOURCES.cross],
}

export interface DisabledSource {
  id: string
  label: string
  platform: 'ebay' | 'amazon'
  /** 发现来源停用即该平台店铺不再采集；交叉验证来源停用只影响热点 Amazon 商品 */
  role: 'discovery' | 'cross'
}

/**
 * 追踪中店铺所需、但在数据中心被停用的来源（实测修正 2026-10-23）。停用是人为操作，
 * 店铺页面若不提示，用户只会看到“没有新品”。
 */
export function disabledSourcesFor(
  platforms: Iterable<'ebay' | 'amazon'>,
  sources: Record<string, SourceState>,
): DisabledSource[] {
  const registry = webConnectors()
  const out: DisabledSource[] = []
  for (const platform of new Set(platforms))
    for (const id of REQUIRED_SOURCES[platform])
      if (sources[id] === 'disabled')
        out.push({
          id,
          label: registry.get(id)?.label ?? id,
          platform,
          role: id === STORE_SOURCES.cross ? 'cross' : 'discovery',
        })
  return out
}

/** 追踪中店铺所需的来源是否全部停用（此时手动一轮不会采集任何数据） */
function allRequiredDisabled(
  platforms: Iterable<'ebay' | 'amazon'>,
  sources: Record<string, SourceState>,
) {
  const required = [...new Set([...platforms].flatMap((p) => REQUIRED_SOURCES[p]))]
  return required.length > 0 && required.every((id) => sources[id] === 'disabled')
}

/** 最近一次发现任务的完成时间：eBay 卖家新品按卖家，Amazon 搜索按店铺搜索词 */
async function lastSyncTimes(
  db: WorkbenchActor['db'],
  stores: readonly { id: string; platform: string; sellerKey: string; keywords: string[] }[],
  since: Date,
) {
  const runs = await db
    .select({
      kind: syncRun.dataKind,
      scope: syncRun.scope,
      finishedAt: syncRun.finishedAt,
    })
    .from(syncRun)
    .where(
      and(
        inArray(syncRun.dataKind, ['seller-new-listings', 'amazon-search']),
        eq(syncRun.status, 'succeeded'),
        gte(syncRun.startedAt, since),
      ),
    )
  const out = new Map<string, string>()
  for (const store of stores) {
    let latest: Date | null = null
    for (const run of runs) {
      const match =
        store.platform === 'ebay'
          ? run.kind === 'seller-new-listings' &&
            String(run.scope.sellerId ?? '').toLowerCase() === store.sellerKey.toLowerCase()
          : run.kind === 'amazon-search' && store.keywords.includes(String(run.scope.keyword ?? ''))
      if (match && run.finishedAt && (!latest || run.finishedAt > latest)) latest = run.finishedAt
    }
    if (latest) out.set(store.id, latest.toISOString())
  }
  return out
}

function toItem(
  view: ListingView,
  tiers: Map<string, { tier: string; tierReason: string | null }>,
): ListingItem {
  const tier = tiers.get(view.productId)
  return {
    productId: view.productId,
    platformId: view.platformId,
    title: view.title,
    url: view.url,
    imageUrl: view.imageUrl,
    firstSeenOn: view.listing.firstSeenOn,
    lastSeenOn: view.listing.lastSeenOn,
    delistedOn: view.listing.delistedOn,
    listedOn: view.listedOn,
    isNew: view.isNew,
    discovery: view.listing.discovery,
    tier: (tier?.tier as ListingItem['tier']) ?? null,
    tierReason: tier?.tierReason ?? null,
    signal: view.signal
      ? {
          on: view.signal.on,
          kind: view.signal.kind,
          low: view.signal.valueLow,
          high: view.signal.valueHigh,
        }
      : null,
    sales: view.sales,
  }
}

/** 店铺 → 新品视图（部署级数据），按店铺分组 */
async function storeViews(db: WorkbenchActor['db'], stores: readonly TrackedStore[], day: string) {
  const rows = (await loadListings(db, stores)).filter(
    (r) => r.firstSeenOn >= addDays(day, -LOOKBACK_DAYS),
  )
  const series = await readSeriesByMarketplace(
    db,
    rows.map((r) => ({ id: r.productId, marketplace: r.marketplace })),
    addDays(day, -LOOKBACK_DAYS),
    day,
  )
  const views = new Map<string, ListingView[]>()
  for (const v of toListingViews(rows, series)) {
    const key = `${v.marketplace}|${v.listing.sellerKey}`
    views.set(key, [...(views.get(key) ?? []), v])
  }
  return views
}

async function directionsOf(actor: WorkbenchActor) {
  return scoped(actor.db, actor.workspaceId)
    .select(direction, {
      fields: {
        id: direction.id,
        name: direction.name,
        marketplaces: direction.marketplaces,
        keywords: direction.keywords,
        categoryIds: direction.categoryIds,
        enabled: direction.enabled,
      },
    })
    .orderBy(direction.createdAt)
}

function toRow(
  store: TrackedStore,
  input: {
    views: readonly ListingView[]
    day: string
    directions: Map<string, { name: string; keywords: string[]; enabled: boolean }>
    sources: Record<string, SourceState>
    lastSync: Map<string, string>
  },
): StoreRowView {
  const { views, day } = input
  const fresh = views.filter((v) => v.isNew !== false)
  return {
    id: store.id,
    platform: store.platform,
    marketplace: store.marketplace,
    sellerKey: store.sellerKey,
    displayName: store.displayName ?? store.sellerKey,
    url: store.url,
    kind: store.kind,
    status: store.status,
    reason: store.reason,
    directionIds: store.directionIds,
    directionNames: store.directionIds
      .map((id) => input.directions.get(id)?.name)
      .filter((n): n is string => Boolean(n)),
    keywords: store.keywords,
    searchKeywords: store.platform === 'amazon' ? storeKeywords(store, input.directions) : [],
    new7d: fresh.filter((v) => v.listing.firstSeenOn > addDays(day, -7)).length,
    new30d: fresh.filter((v) => v.listing.firstSeenOn > addDays(day, -30)).length,
    pending: views.filter((v) => v.isNew === null).length,
    hitRate: metricsOf(views, day).hitRate,
    lastSyncAt: input.lastSync.get(store.id) ?? null,
    source: input.sources[sourceOf(store.platform)] ?? 'unregistered',
    createdAt: store.createdAt.toISOString(),
  }
}

export async function storesPage(actor: WorkbenchActor, now = new Date()) {
  const day = localDay(now, SELECTION_TIME_ZONE)
  const all = await listStores(actor.db, actor.workspaceId, { includeRemoved: true })
  const stores = all.filter((s) => s.status !== 'removed')
  const directionRows = await directionsOf(actor)
  const directions = new Map(directionRows.map((d) => [d.id, d]))
  const [views, sources] = await Promise.all([
    storeViews(actor.db, stores, day),
    sourceStates(actor.db, now),
  ])
  const lastSync = await lastSyncTimes(
    actor.db,
    stores.map((s) => ({
      id: s.id,
      platform: s.platform,
      sellerKey: s.sellerKey,
      keywords: s.platform === 'amazon' ? storeKeywords(s, directions) : [],
    })),
    new Date(now.getTime() - 30 * 86_400_000),
  )
  return {
    day,
    stores: stores.map((store) =>
      toRow(store, {
        views: views.get(`${store.marketplace}|${store.sellerKey}`) ?? [],
        day,
        directions,
        sources,
        lastSync,
      }),
    ),
    removedCount: all.length - stores.length,
    directions: directionRows.map((d) => ({
      id: d.id,
      name: d.name,
      marketplaces: d.marketplaces,
    })),
    sources,
    disabledSources: disabledSourcesFor(
      stores.filter((s) => s.status === 'active').map((s) => s.platform),
      sources,
    ),
  }
}

export async function storeDetail(actor: WorkbenchActor, id: string, now = new Date()) {
  const day = localDay(now, SELECTION_TIME_ZONE)
  const store = await getStore(actor.db, actor.workspaceId, id)
  const directionRows = await directionsOf(actor)
  const directions = new Map(directionRows.map((d) => [d.id, d]))
  const [views, sources, tracked] = await Promise.all([
    storeViews(actor.db, [store], day),
    sourceStates(actor.db, now),
    listTrackedProducts(actor.db, actor.workspaceId),
  ])
  const own = views.get(`${store.marketplace}|${store.sellerKey}`) ?? []
  const lastSync = await lastSyncTimes(
    actor.db,
    [
      {
        id: store.id,
        platform: store.platform,
        sellerKey: store.sellerKey,
        keywords: store.platform === 'amazon' ? storeKeywords(store, directions) : [],
      },
    ],
    new Date(now.getTime() - 30 * 86_400_000),
  )
  const tiers = new Map(tracked.map((t) => [t.productId, t]))
  const metrics = metricsOf(own, day)
  return {
    day,
    store: toRow(store, { views: own, day, directions, sources, lastSync }),
    listings: own.map((v) => toItem(v, tiers)),
    metrics,
    coverage: {
      method: store.platform === 'ebay' ? ('browse-seller' as const) : ('search-offer' as const),
      found30d: own.filter((v) => v.listing.firstSeenOn > addDays(day, -30)).length,
    },
    directions: directionRows.map((d) => ({
      id: d.id,
      name: d.name,
      marketplaces: d.marketplaces,
    })),
    disabledSources:
      store.status === 'removed' ? [] : disabledSourcesFor([store.platform], sources),
  }
}

/** 店铺页解析失败只记录原因，不把页面内容写进日志 */
async function resolveEbayStore(storeName: string) {
  const result = await resolveEbayStoreUsername(storeName)
  if (result.ok) return result.username
  log.warn('stores.ebay_store_unresolved', { reason: result.reason })
  return null
}

/** 解析预览：页面粘贴链接后先看解析结果，不写库 */
export function previewStoreLink(url: string): StoreLinkResult & { message?: string } {
  const parsed = parseStoreLink(url)
  return parsed.ok ? parsed : { ...parsed, message: STORE_LINK_ERRORS[parsed.reason] }
}

export async function createTrackedStore(
  actor: WorkbenchActor,
  input: StoreSettingsInput & { url: string },
) {
  assertWorkbenchWriter(actor)
  const { store } = await addStore(actor.db, actor.workspaceId, input, { resolveEbayStore })
  return { id: store.id }
}

export async function saveTrackedStore(
  actor: WorkbenchActor,
  id: string,
  input: StoreSettingsInput,
) {
  assertWorkbenchWriter(actor)
  await updateStore(actor.db, actor.workspaceId, id, input)
  return { ok: true }
}

export async function changeStoreStatus(
  actor: WorkbenchActor,
  id: string,
  status: TrackedStoreStatus,
) {
  assertWorkbenchWriter(actor)
  await setStoreStatus(actor.db, actor.workspaceId, id, status)
  return { ok: true }
}

/**
 * 立即跑一轮（手动触发，tasks 5.1 验收入口）：投递到 jobs 的店铺追踪队列，只处理本空间，
 * 定时计划暂停（DATA_PIPELINE_SCHEDULES=paused）时同样可用。同一空间每小时最多一轮。
 */
export async function requestStoreRound(
  actor: WorkbenchActor,
  queue: Capability<QueueProducer<StoreRoundMessage>> | undefined,
  now = new Date(),
) {
  assertWorkbenchWriter(actor)
  if (!queue?.available)
    throw new AppError('STORE_QUEUE_UNAVAILABLE', '当前部署没有启用店铺追踪队列', { status: 503 })
  const key = storeRoundKey(actor.workspaceId, now)
  const [existing] = await actor.db
    .select({ id: jobMessage.id })
    .from(jobMessage)
    .where(and(eq(jobMessage.queue, STORE_TRACKING_QUEUE), eq(jobMessage.idempotencyKey, key)))
    .limit(1)
  if (existing) return { queued: false as const, reason: 'already-queued' as const }
  // 所需来源全部停用时这一轮不会采集任何数据：不占用本小时的名额，直接提示去数据中心启用
  const platforms = (await listStores(actor.db, actor.workspaceId))
    .filter((s) => s.status === 'active')
    .map((s) => s.platform)
  const sources = await sourceStates(actor.db, now)
  if (allRequiredDisabled(platforms, sources))
    return {
      queued: false as const,
      reason: 'sources-disabled' as const,
      disabledSources: disabledSourcesFor(platforms, sources),
    }
  await queue.value.send({
    v: 1,
    type: 'store-tracking-round',
    workspaceId: actor.workspaceId,
    requestedAt: now.toISOString(),
    idempotencyKey: key,
  })
  return { queued: true as const }
}
