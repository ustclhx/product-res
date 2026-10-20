import type { FetchTask, NormalizedBatch } from '@product-res/datasources'
import { type Database, storeListing, trackedStore } from '@product-res/db'
import { entityRef } from '@product-res/marketdata'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

/**
 * 店铺 × 商品的出现记录（store_listing，部署级；design D4）。由同步任务的批次回调写入：
 * - eBay `seller-new-listings`：Browse 卖家新品，结果都属于 scope.sellerId（discovery = browse-seller）
 * - Amazon `amazon-offers`：报价的卖家 ID 或卖家名命中店铺池（discovery = search-offer）；
 *   已记录的店铺在新报价中消失时记为下架
 * - 商品快照（product-snapshot / amazon-asin / amazon-product）：有价格即仍在售，更新最近出现；
 *   eBay 可售量为 0 记为下架
 * 只记录店铺池中追踪中的店铺（任一空间），不记录其他卖家。
 */

export const STORE_SNAPSHOT_KINDS: ReadonlySet<string> = new Set([
  'product-snapshot',
  'amazon-asin',
  'amazon-product',
])

const platformOf = (marketplace: string) => marketplace.split('-')[0] as 'ebay' | 'amazon'
const lower = (value: string) => value.trim().toLowerCase()

export interface ActiveStoreKey {
  readonly platform: 'ebay' | 'amazon'
  readonly marketplace: string
  readonly sellerKey: string
  readonly displayName: string | null
}

/** 所有空间中追踪中的店铺（按站点 × 卖家去重）；系统任务跨空间读取，只取匹配所需的列 */
export async function activeStoreKeys(
  db: Database,
  marketplace?: string,
): Promise<ActiveStoreKey[]> {
  const rows = await db
    .selectDistinct({
      platform: trackedStore.platform,
      marketplace: trackedStore.marketplace,
      sellerKey: trackedStore.sellerKey,
      displayName: trackedStore.displayName,
    })
    .from(trackedStore)
    .where(
      and(
        eq(trackedStore.status, 'active'),
        ...(marketplace ? [eq(trackedStore.marketplace, marketplace)] : []),
      ),
    )
  const unique = new Map<string, ActiveStoreKey>()
  for (const row of rows) unique.set(`${row.marketplace}|${row.sellerKey}`, row)
  return [...unique.values()]
}

export interface ListingSighting {
  readonly sellerKey: string
  readonly productId: string
}

/**
 * 报价 → 命中的店铺：卖家 ID 精确匹配（大小写不敏感），没有 ID 时卖家名与店铺显示名相同。
 * 纯函数，便于测试。
 */
export function matchOffers(
  offers: readonly {
    productRef: string
    sellerId?: string | undefined
    sellerName?: string | undefined
  }[],
  stores: readonly Pick<ActiveStoreKey, 'sellerKey' | 'displayName'>[],
): { productRef: string; sellerKey: string }[] {
  const byId = new Map(stores.map((s) => [lower(s.sellerKey), s.sellerKey]))
  const byName = new Map<string, string>()
  for (const s of stores) if (s.displayName) byName.set(lower(s.displayName), s.sellerKey)
  const out = new Map<string, { productRef: string; sellerKey: string }>()
  for (const offer of offers) {
    const key =
      (offer.sellerId ? byId.get(lower(offer.sellerId)) : undefined) ??
      (offer.sellerName ? byName.get(lower(offer.sellerName)) : undefined)
    if (key) out.set(`${offer.productRef}|${key}`, { productRef: offer.productRef, sellerKey: key })
  }
  return [...out.values()]
}

async function upsertSightings(
  db: Database,
  platform: 'ebay' | 'amazon',
  sightings: readonly ListingSighting[],
  observedOn: string,
  discovery: 'browse-seller' | 'search-offer',
) {
  if (sightings.length === 0) return []
  const before = await db
    .select({ sellerKey: storeListing.sellerKey, productId: storeListing.productId })
    .from(storeListing)
    .where(
      and(
        eq(storeListing.platform, platform),
        inArray(storeListing.productId, [...new Set(sightings.map((s) => s.productId))]),
      ),
    )
  const known = new Set(before.map((r) => `${r.sellerKey}|${r.productId}`))
  await db
    .insert(storeListing)
    .values(
      sightings.map((s) => ({
        platform,
        sellerKey: s.sellerKey,
        productId: s.productId,
        firstSeenOn: observedOn,
        lastSeenOn: observedOn,
        discovery,
      })),
    )
    .onConflictDoUpdate({
      target: [storeListing.platform, storeListing.sellerKey, storeListing.productId],
      set: {
        lastSeenOn: sql`greatest(${storeListing.lastSeenOn}, excluded.last_seen_on)`,
        // 重新出现说明仍在售：清除下架标记
        delistedOn: sql`null`,
        updatedAt: sql`now()`,
      },
    })
  return sightings.filter((s) => !known.has(`${s.sellerKey}|${s.productId}`))
}

export interface RecordResult {
  /** 首次发现的店铺新品 */
  readonly created: readonly ListingSighting[]
  /** 本批更新了最近出现或下架的记录数 */
  readonly touched: number
}

/** 同步批次 → store_listing；与店铺无关的任务直接返回 */
export async function recordStoreListings(
  db: Database,
  input: {
    readonly task: FetchTask
    readonly batch: NormalizedBatch
    readonly ids: ReadonlyMap<string, string>
    readonly observedOn: string
  },
): Promise<RecordResult> {
  const { task, batch, ids, observedOn } = input
  const platform = platformOf(task.marketplace)
  if (task.kind === 'seller-new-listings') {
    const seller = String(task.scope.sellerId ?? '')
    const stores = await activeStoreKeys(db, task.marketplace)
    const store = stores.find((s) => lower(s.sellerKey) === lower(seller))
    if (!store) return { created: [], touched: 0 }
    const sightings = batch.entities
      .filter((e) => e.key.type === 'product')
      .map((e) => ids.get(entityRef(e.key)))
      .filter((id): id is string => Boolean(id))
      .map((productId) => ({ sellerKey: store.sellerKey, productId }))
    const created = await upsertSightings(db, platform, sightings, observedOn, 'browse-seller')
    return { created, touched: sightings.length }
  }
  if (task.kind === 'amazon-offers') {
    const stores = await activeStoreKeys(db, task.marketplace)
    if (stores.length === 0) return { created: [], touched: 0 }
    const offers = (batch.offers ?? []).map((o) => ({
      productRef: entityRef(o.product),
      sellerId: o.sellerId,
      sellerName: o.sellerName,
    }))
    const matched = matchOffers(offers, stores)
    const sightings = matched
      .map((m) => ({ sellerKey: m.sellerKey, productId: ids.get(m.productRef) }))
      .filter((s): s is ListingSighting => Boolean(s.productId))
    const created = await upsertSightings(db, platform, sightings, observedOn, 'search-offer')
    // 本批查过报价的商品中，已记录的店铺不在报价里 → 下架
    const checked = batch.entities
      .filter((e) => e.key.type === 'product')
      .map((e) => ids.get(entityRef(e.key)))
      .filter((id): id is string => Boolean(id))
    let delisted = 0
    if (checked.length > 0) {
      const present = new Set(sightings.map((s) => `${s.sellerKey}|${s.productId}`))
      const rows = await db
        .select({
          id: storeListing.id,
          sellerKey: storeListing.sellerKey,
          productId: storeListing.productId,
        })
        .from(storeListing)
        .where(
          and(
            eq(storeListing.platform, platform),
            inArray(storeListing.productId, checked),
            isNull(storeListing.delistedOn),
          ),
        )
      const gone = rows
        .filter((r) => !present.has(`${r.sellerKey}|${r.productId}`))
        .map((r) => r.id)
      if (gone.length > 0) {
        await db
          .update(storeListing)
          .set({ delistedOn: observedOn })
          .where(inArray(storeListing.id, gone))
        delisted = gone.length
      }
    }
    return { created, touched: sightings.length + delisted }
  }
  if (STORE_SNAPSHOT_KINDS.has(task.kind)) {
    const priced = new Set<string>()
    const soldOut = new Set<string>()
    for (const o of batch.observations) {
      const id = ids.get(entityRef(o.entity))
      if (!id) continue
      if (o.metric === 'price') priced.add(id)
      if (o.metric === 'available_quantity' && o.value === 0) soldOut.add(id)
    }
    let touched = 0
    const alive = [...priced].filter((id) => !soldOut.has(id))
    if (alive.length > 0) {
      const rows = await db
        .update(storeListing)
        .set({
          lastSeenOn: sql`greatest(${storeListing.lastSeenOn}, ${observedOn}::date)`,
          delistedOn: null,
        })
        .where(and(eq(storeListing.platform, platform), inArray(storeListing.productId, alive)))
        .returning({ id: storeListing.id })
      touched += rows.length
    }
    if (soldOut.size > 0) {
      const rows = await db
        .update(storeListing)
        .set({ delistedOn: observedOn })
        .where(
          and(
            eq(storeListing.platform, platform),
            inArray(storeListing.productId, [...soldOut]),
            isNull(storeListing.delistedOn),
          ),
        )
        .returning({ id: storeListing.id })
      touched += rows.length
    }
    return { created: [], touched }
  }
  return { created: [], touched: 0 }
}
