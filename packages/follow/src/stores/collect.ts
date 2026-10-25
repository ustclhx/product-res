import type { FetchTask, Marketplace } from '@product-res/datasources'
import {
  type Database,
  direction,
  marketplaceProduct,
  scoped,
  syncRun,
  type TrackedStore,
  trackedProduct,
  trackedStore,
  transferringWorkspaceIds,
} from '@product-res/db'
import { normalizePhrase } from '@product-res/marketdata'
import { addDays } from '@product-res/selection'
import { and, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm'
import type { SellerTarget, SourceAllowance } from '../collect.ts'
import { taskKey } from '../collect.ts'
import { MAX_STORE_KEYWORDS } from './pool.ts'
import { STORE_TRACKING_DEFAULTS, type StoreTrackingSettings } from './rules.ts'

/**
 * 店铺追踪的采集计划（design D4、D5、D3）：
 * - Amazon 店铺：每店 1–5 个搜索词，每 3 天 `amazon-search`（DataForSEO）；新 ASIN 的报价由搜索结果回调投递
 * - eBay 店铺：Browse 卖家新品（每日流水线已合并店铺池，手动触发时这里补上）
 * - 被追踪商品快照：热点每日、普通每 5 天、冷门停追（Amazon `amazon-asin`，eBay Browse 快照）
 * - 热点 Amazon 商品另由 SerpApi `amazon-product` 交叉采集，按月预算日均分配，线索与区间变化优先
 * 读取部分跨空间列出店铺与被追踪商品，计划部分（planStoreTasks）是纯函数。
 */

export const STORE_SOURCES = {
  amazon: 'dataforseo',
  ebay: 'ebay-browse',
  cross: 'serpapi',
} as const

const ASIN_BATCH = 10
const EBAY_BATCH = 20

const platformOf = (marketplace: string) => marketplace.split('-')[0]

export interface StoreSearchTarget {
  readonly marketplace: string
  readonly keyword: string
}

export interface StoreSnapshotTarget {
  readonly productId: string
  readonly marketplace: string
  readonly platformId: string
  readonly tier: 'hot' | 'normal'
  /** 交叉采集的优先级（小者优先）：近 7 天新进线索 / 出单 / 区间上升为 0，其他为 1 */
  readonly crossPriority: number
  readonly workspaceIds: readonly string[]
}

export interface StoreCollectionTargets {
  readonly searches: readonly StoreSearchTarget[]
  readonly sellers: readonly SellerTarget[]
  readonly snapshots: readonly StoreSnapshotTarget[]
}

/** 店铺的发现搜索词：店铺自己的（1–5 个），为空时取关联的启用方向的关键词 */
export function storeKeywords(
  store: Pick<TrackedStore, 'keywords' | 'directionIds'>,
  directions: ReadonlyMap<string, { keywords: readonly string[]; enabled: boolean }>,
): string[] {
  const own = store.keywords.map(normalizePhrase).filter(Boolean)
  const source =
    own.length > 0
      ? own
      : store.directionIds.flatMap((id) => {
          const d = directions.get(id)
          return d?.enabled ? d.keywords.map(normalizePhrase).filter(Boolean) : []
        })
  return [...new Set(source)].slice(0, MAX_STORE_KEYWORDS)
}

/** eBay 店铺 → Browse 卖家新品对象：类目取关联方向，没有类目用关键词 */
export function storeSellerTarget(
  store: Pick<TrackedStore, 'marketplace' | 'sellerKey' | 'keywords' | 'directionIds'>,
  directions: ReadonlyMap<
    string,
    { keywords: readonly string[]; categoryIds: readonly string[]; enabled: boolean }
  >,
): SellerTarget {
  const linked = store.directionIds
    .map((id) => directions.get(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d?.enabled))
  return {
    marketplace: store.marketplace,
    sellerId: store.sellerKey,
    categoryIds: [...new Set(linked.flatMap((d) => d.categoryIds))],
    keywords: storeKeywords(store, directions),
  }
}

async function directionMap(db: Database, workspaceId: string) {
  const rows = await scoped(db, workspaceId).select(direction, {
    fields: {
      id: direction.id,
      keywords: direction.keywords,
      categoryIds: direction.categoryIds,
      enabled: direction.enabled,
    },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

/** 一个空间店铺池中的 eBay 店铺（每日 Browse 卖家新品合并用） */
export async function storeSellerTargets(db: Database, workspaceId: string) {
  const stores = await scoped(db, workspaceId).select(trackedStore, {
    where: and(eq(trackedStore.status, 'active'), eq(trackedStore.platform, 'ebay')) as SQL,
  })
  if (stores.length === 0) return []
  const directions = await directionMap(db, workspaceId)
  return stores.map((s) => storeSellerTarget(s, directions))
}

/** 近 N 天内已成功搜索过的关键词（站点|关键词） */
async function recentSearches(db: Database, since: Date) {
  const rows = await db
    .select({
      marketplace: syncRun.marketplace,
      keyword: sql<string | null>`${syncRun.scope}->>'keyword'`,
    })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.sourceId, STORE_SOURCES.amazon),
        eq(syncRun.dataKind, 'amazon-search'),
        eq(syncRun.status, 'succeeded'),
        gte(syncRun.startedAt, since),
      ),
    )
  return new Set(rows.map((r) => `${r.marketplace}|${normalizePhrase(r.keyword ?? '')}`))
}

/**
 * 读取采集对象。workspaceId 给出时只看该空间（手动触发）；force 时忽略搜索与快照周期，
 * 采集所有追踪中的店铺与非冷门商品。
 */
export async function loadStoreCollectionTargets(
  db: Database,
  options: {
    readonly day: string
    readonly now: Date
    readonly workspaceId?: string | undefined
    readonly force?: boolean | undefined
    readonly settings?: Partial<StoreTrackingSettings> | undefined
  },
): Promise<StoreCollectionTargets> {
  const settings = { ...STORE_TRACKING_DEFAULTS, ...options.settings }
  const workspaceIds = options.workspaceId
    ? [options.workspaceId]
    : [
        ...new Set(
          (
            await db
              .selectDistinct({ workspaceId: trackedStore.workspaceId })
              .from(trackedStore)
              .where(eq(trackedStore.status, 'active'))
          )
            .concat(
              await db
                .selectDistinct({ workspaceId: trackedProduct.workspaceId })
                .from(trackedProduct)
                .where(inArray(trackedProduct.tier, ['hot', 'normal'])),
            )
            .map((r) => r.workspaceId),
        ),
      ]
  // 搜索周期按 3 天计；留 6 小时余量，避免每日运行时间的抖动把第 3 天推到第 4 天
  const searchedSince = new Date(
    options.now.getTime() - (settings.searchEveryDays * 24 - 6) * 3_600_000,
  )
  const searched = options.force ? new Set<string>() : await recentSearches(db, searchedSince)
  const searches = new Map<string, StoreSearchTarget>()
  const sellers: SellerTarget[] = []
  const snapshotRows: {
    workspaceId: string
    productId: string
    tier: 'hot' | 'normal'
    crossPriority: number
  }[] = []
  const transferring = await transferringWorkspaceIds(db)
  for (const workspaceId of workspaceIds) {
    if (transferring.has(workspaceId)) continue
    const s = scoped(db, workspaceId)
    const stores = await s.select(trackedStore, { where: eq(trackedStore.status, 'active') })
    const directions = stores.length > 0 ? await directionMap(db, workspaceId) : new Map()
    for (const store of stores) {
      if (store.platform === 'amazon') {
        for (const keyword of storeKeywords(store, directions)) {
          const key = `${store.marketplace}|${keyword}`
          if (!searched.has(key)) searches.set(key, { marketplace: store.marketplace, keyword })
        }
      } else if (options.workspaceId) sellers.push(storeSellerTarget(store, directions))
    }
    const normalDue = addDays(options.day, -settings.normalEveryDays)
    const recent = new Date(`${addDays(options.day, -settings.risingDays)}T00:00:00Z`)
    const due = options.force
      ? inArray(trackedProduct.tier, ['hot', 'normal'])
      : (or(
          and(
            eq(trackedProduct.tier, 'hot'),
            or(
              isNull(trackedProduct.lastSnapshotOn),
              lt(trackedProduct.lastSnapshotOn, options.day),
            ),
          ),
          and(
            eq(trackedProduct.tier, 'normal'),
            or(
              isNull(trackedProduct.lastSnapshotOn),
              lte(trackedProduct.lastSnapshotOn, normalDue),
            ),
          ),
        ) as SQL)
    const products = await s.select(trackedProduct, { where: due })
    for (const p of products)
      snapshotRows.push({
        workspaceId,
        productId: p.productId,
        tier: p.tier as 'hot' | 'normal',
        crossPriority:
          p.tier === 'hot' &&
          p.tierChangedAt >= recent &&
          ['new-lead', 'sale-signal', 'bought-up'].includes(p.tierReason ?? '')
            ? 0
            : 1,
      })
  }
  const snapshots = new Map<string, StoreSnapshotTarget>()
  const ids = [...new Set(snapshotRows.map((r) => r.productId))]
  const products = new Map<string, { marketplace: string; platformId: string }>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({
        id: marketplaceProduct.id,
        marketplace: marketplaceProduct.marketplace,
        platformId: marketplaceProduct.platformId,
      })
      .from(marketplaceProduct)
      .where(inArray(marketplaceProduct.id, ids.slice(i, i + 500)))
    for (const r of rows) products.set(r.id, r)
  }
  for (const row of snapshotRows) {
    const product = products.get(row.productId)
    if (!product) continue
    const seen = snapshots.get(row.productId)
    snapshots.set(row.productId, {
      productId: row.productId,
      marketplace: product.marketplace,
      platformId: product.platformId,
      tier: seen?.tier === 'hot' || row.tier === 'hot' ? 'hot' : 'normal',
      crossPriority: Math.min(seen?.crossPriority ?? 1, row.crossPriority),
      workspaceIds: [...(seen?.workspaceIds ?? []), row.workspaceId],
    })
  }
  return { searches: [...searches.values()], sellers, snapshots: [...snapshots.values()] }
}

/** 投递后把快照日记到被追踪商品上（按空间） */
export async function markSnapshotted(
  db: Database,
  targets: readonly StoreSnapshotTarget[],
  day: string,
) {
  const byWorkspace = new Map<string, string[]>()
  for (const t of targets)
    for (const ws of t.workspaceIds)
      byWorkspace.set(ws, [...(byWorkspace.get(ws) ?? []), t.productId])
  for (const [workspaceId, productIds] of byWorkspace)
    await scoped(db, workspaceId).update(
      trackedProduct,
      { lastSnapshotOn: day },
      inArray(trackedProduct.productId, productIds),
    )
}

export interface StoreTask {
  readonly sourceId: string
  readonly task: FetchTask
  /** 小者优先；同一数据源按此截断 */
  readonly priority: number
  readonly key: string
  /** 本任务覆盖的被追踪商品（用于记快照日） */
  readonly productIds: readonly string[]
}

export interface StorePlan {
  readonly tasks: readonly StoreTask[]
  /** 因额度截断、顺延到之后运行的任务数 */
  readonly truncated: Readonly<Record<string, number>>
  /** 数据源不可用（未配置、停用、暂停）而未生成的任务数 */
  readonly unavailable: Readonly<Record<string, number>>
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 每日 / 手动运行的采集任务：去重 → 优先级 → 按各数据源额度严格截断 */
export function planStoreTasks(
  targets: StoreCollectionTargets,
  sources: ReadonlyMap<string, SourceAllowance>,
): StorePlan {
  const candidates: Omit<StoreTask, 'key'>[] = []
  // eBay 卖家新品（手动触发时；每日由 datasources 流水线投递）
  for (const s of targets.sellers) {
    const filters: Record<string, string>[] =
      s.categoryIds.length > 0
        ? s.categoryIds.map((c) => ({ categoryIds: c }))
        : s.keywords.map((q) => ({ q }))
    for (const filter of filters)
      candidates.push({
        sourceId: STORE_SOURCES.ebay,
        task: {
          kind: 'seller-new-listings',
          marketplace: s.marketplace as Marketplace,
          scope: { sellerId: s.sellerId, ...filter },
        },
        priority: 0,
        productIds: [],
      })
  }
  // 快照：热点优先于搜索，普通档最后
  const groups = new Map<string, StoreSnapshotTarget[]>()
  for (const p of targets.snapshots) {
    const key = `${platformOf(p.marketplace)}|${p.marketplace}|${p.tier}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  for (const [key, list] of groups) {
    const [platform, marketplace, tier] = key.split('|') as [string, string, 'hot' | 'normal']
    const amazon = platform === 'amazon'
    if (!amazon && platform !== 'ebay') continue
    const sorted = [...list].sort((a, b) => a.platformId.localeCompare(b.platformId))
    for (const batch of chunk(sorted, amazon ? ASIN_BATCH : EBAY_BATCH))
      candidates.push({
        sourceId: amazon ? STORE_SOURCES.amazon : STORE_SOURCES.ebay,
        task: {
          kind: amazon ? 'amazon-asin' : 'product-snapshot',
          marketplace: marketplace as Marketplace,
          scope: { ids: batch.map((p) => p.platformId) },
        },
        priority: tier === 'hot' ? 1 : 3,
        productIds: batch.map((p) => p.productId),
      })
  }
  for (const s of [...targets.searches].sort((a, b) => a.keyword.localeCompare(b.keyword)))
    candidates.push({
      sourceId: STORE_SOURCES.amazon,
      task: {
        kind: 'amazon-search',
        marketplace: s.marketplace as Marketplace,
        scope: { keyword: s.keyword },
      },
      priority: 2,
      productIds: [],
    })
  // SerpApi 交叉采集：热点 Amazon 商品逐个，线索 / 区间变化优先
  const cross = targets.snapshots
    .filter((p) => p.tier === 'hot' && platformOf(p.marketplace) === 'amazon')
    .sort((a, b) => a.crossPriority - b.crossPriority || a.platformId.localeCompare(b.platformId))
  for (const p of cross)
    candidates.push({
      sourceId: STORE_SOURCES.cross,
      task: {
        kind: 'amazon-product',
        marketplace: p.marketplace as Marketplace,
        scope: { ids: [p.platformId] },
      },
      priority: 10 + p.crossPriority,
      productIds: [],
    })

  const tasks: StoreTask[] = []
  const truncated: Record<string, number> = {}
  const unavailable: Record<string, number> = {}
  const bySource = new Map<string, Omit<StoreTask, 'key'>[]>()
  for (const c of candidates) bySource.set(c.sourceId, [...(bySource.get(c.sourceId) ?? []), c])
  for (const [sourceId, list] of bySource) {
    const allowance = sources.get(sourceId)
    if (!allowance) {
      unavailable[sourceId] = list.length
      continue
    }
    const ordered = list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
      .map(({ c }) => c)
    let used = 0
    for (const [index, c] of ordered.entries()) {
      const cost = allowance.connector.plan(c.task)
      if (used + cost > allowance.headroom) {
        truncated[sourceId] = ordered.length - index
        break
      }
      used += cost
      tasks.push({ ...c, key: taskKey(sourceId, c.task) })
    }
  }
  tasks.sort((a, b) => a.priority - b.priority)
  return { tasks, truncated, unavailable }
}
