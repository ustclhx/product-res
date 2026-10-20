import type { NormalizedBatch } from '@product-res/datasources'
import { type Database, storeListing, syncRun } from '@product-res/db'
import { entityRef } from '@product-res/marketdata'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { STORE_SOURCES } from './collect.ts'
import { activeStoreKeys } from './listings.ts'

/**
 * Amazon 店铺新品的报价归属（design D4）：店铺搜索词的结果中，尚未查过报价的 ASIN
 * 逐个跑 `amazon-offers`，卖家命中店铺池的写入 store_listing（见 listings.ts）。
 * 每日报价调用有上限（默认 30），超出的顺延由投递方（apps/jobs）按天排队。
 */

/** 已成功查过报价的 ASIN（任一次 amazon-offers 运行的 scope.ids） */
export async function checkedOfferAsins(
  db: Database,
  marketplace: string,
  asins: readonly string[],
): Promise<Set<string>> {
  if (asins.length === 0) return new Set()
  const rows = await db
    .select({ asin: sql<string>`jsonb_array_elements_text(${syncRun.scope}->'ids')` })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.sourceId, STORE_SOURCES.amazon),
        eq(syncRun.dataKind, 'amazon-offers'),
        eq(syncRun.marketplace, marketplace),
        eq(syncRun.status, 'succeeded'),
      ),
    )
  const wanted = new Set(asins)
  return new Set(rows.map((r) => r.asin).filter((asin) => wanted.has(asin)))
}

/**
 * 一次店铺搜索结果中需要查报价的 ASIN，按“可能属于店铺”的程度排序：
 * 标题或品牌包含店铺显示名的在前，其余保持搜索结果顺序（自然结果在前）。
 * 已查过报价或已归属任一店铺的跳过。
 */
export async function offerCandidates(
  db: Database,
  input: {
    readonly marketplace: string
    readonly batch: NormalizedBatch
    readonly ids: ReadonlyMap<string, string>
  },
): Promise<string[]> {
  const products = input.batch.entities
    .filter((e) => e.key.type === 'product')
    .map((e) => ({
      asin: e.key.platformId,
      productId: input.ids.get(entityRef(e.key)),
      text: `${e.facts?.title ?? ''} ${e.facts?.brand ?? ''}`.toLowerCase(),
    }))
  if (products.length === 0) return []
  const checked = await checkedOfferAsins(
    db,
    input.marketplace,
    products.map((p) => p.asin),
  )
  const productIds = products.map((p) => p.productId).filter((id): id is string => Boolean(id))
  const listed = new Set(
    productIds.length === 0
      ? []
      : (
          await db
            .select({ productId: storeListing.productId })
            .from(storeListing)
            .where(
              and(eq(storeListing.platform, 'amazon'), inArray(storeListing.productId, productIds)),
            )
        ).map((r) => r.productId),
  )
  const names = (await activeStoreKeys(db, input.marketplace))
    .map((s) => s.displayName?.trim().toLowerCase())
    .filter((n): n is string => Boolean(n && n.length >= 3))
  const fresh = products.filter(
    (p) => !checked.has(p.asin) && !(p.productId && listed.has(p.productId)),
  )
  const likely = fresh.filter((p) => names.some((n) => p.text.includes(n)))
  const rest = fresh.filter((p) => !likely.includes(p))
  return [...new Set([...likely, ...rest].map((p) => p.asin))]
}
