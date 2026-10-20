import type { EntityKey, Marketplace } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { marketplaceKeyword, marketplaceProduct, observation } from '@product-res/db/schema'
import { and, asc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm'
import {
  type DisqualifiedCheck,
  dispersionOf,
  getPriority,
  loadDisqualified,
  type MetricPoint,
  normalizePhrase,
  rankValues,
  type SourceValue,
  toSourceValue,
} from './observations.ts'

/**
 * 批量读取（跟卖选品流水线 add-follow-selection tasks 3.1）：按方向范围找商品、
 * 一次读取多个实体的多个指标。逐实体调用 readMetric 在每日流水线中会产生大量往返。
 */

export type MarketProduct = typeof marketplaceProduct.$inferSelect

export interface ProductScope {
  readonly marketplaces: readonly Marketplace[]
  readonly categoryIds?: readonly string[] | undefined
  /** 对标店铺：站点 × 平台卖家 ID */
  readonly sellers?: readonly { marketplace: string; sellerId: string }[] | undefined
  /** 标题包含任一关键词（不区分大小写） */
  readonly keywords?: readonly string[] | undefined
  /** 单次读取上限，防止范围过宽时读入整个站点 */
  readonly limit?: number | undefined
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * 方向范围内的商品：站点在范围内，且命中类目、对标店铺或标题关键词任一条件。
 * 三个条件都为空时返回空列表（不把整个站点当作范围）。
 */
export async function findProducts(db: Database, scope: ProductScope): Promise<MarketProduct[]> {
  if (scope.marketplaces.length === 0) return []
  const conditions: SQL[] = []
  const categories = [...new Set(scope.categoryIds ?? [])].filter(Boolean)
  if (categories.length > 0) conditions.push(inArray(marketplaceProduct.categoryId, categories))
  for (const seller of scope.sellers ?? []) {
    conditions.push(
      and(
        eq(marketplaceProduct.marketplace, seller.marketplace),
        eq(marketplaceProduct.sellerId, seller.sellerId),
      ) as SQL,
    )
  }
  for (const keyword of new Set((scope.keywords ?? []).map(normalizePhrase))) {
    if (keyword) conditions.push(ilike(marketplaceProduct.title, `%${escapeLike(keyword)}%`))
  }
  if (conditions.length === 0) return []
  return db
    .select()
    .from(marketplaceProduct)
    .where(and(inArray(marketplaceProduct.marketplace, [...scope.marketplaces]), or(...conditions)))
    .orderBy(asc(marketplaceProduct.firstSeenAt), asc(marketplaceProduct.id))
    .limit(scope.limit ?? 5000)
}

export async function productsByIds(
  db: Database,
  ids: readonly string[],
): Promise<MarketProduct[]> {
  const out: MarketProduct[] = []
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 500) {
    out.push(
      ...(await db
        .select()
        .from(marketplaceProduct)
        .where(inArray(marketplaceProduct.id, unique.slice(i, i + 500)))),
    )
  }
  return out
}

/** 关键词 → 各站点的实体 ID（关键词按 normalizePhrase 匹配） */
export async function keywordIds(
  db: Database,
  phrases: readonly string[],
): Promise<{ id: string; marketplace: string; phrase: string }[]> {
  const normalized = [...new Set(phrases.map(normalizePhrase))].filter(Boolean)
  if (normalized.length === 0) return []
  return db
    .select({
      id: marketplaceKeyword.id,
      marketplace: marketplaceKeyword.marketplace,
      phrase: marketplaceKeyword.phrase,
    })
    .from(marketplaceKeyword)
    .where(inArray(marketplaceKeyword.phrase, normalized))
}

/** 实体 ID → 指标 → 按日期升序的序列（每天含主值、全部来源与离散度，与 readMetric 一致） */
export type MetricSeriesMap = Map<string, Map<string, MetricPoint[]>>

export async function readMetricSeries(
  db: Database,
  input: {
    readonly entityType: EntityKey['type']
    readonly entityIds: readonly string[]
    readonly metrics: readonly string[]
    /** 用于取来源优先级的站点 */
    readonly marketplace: Marketplace
    readonly from?: string | undefined
    readonly to?: string | undefined
    /** 主值资格；未传时读取 source_qualification */
    readonly disqualified?: DisqualifiedCheck | undefined
  },
): Promise<MetricSeriesMap> {
  const result: MetricSeriesMap = new Map()
  const ids = [...new Set(input.entityIds)]
  if (ids.length === 0 || input.metrics.length === 0) return result
  const priorities = new Map<string, readonly string[]>()
  for (const metric of input.metrics) {
    priorities.set(metric, await getPriority(db, input.marketplace, metric))
  }
  const disqualified = input.disqualified ?? (await loadDisqualified(db))
  const grouped = new Map<string, SourceValue[]>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select()
      .from(observation)
      .where(
        and(
          eq(observation.entityType, input.entityType),
          inArray(observation.entityId, ids.slice(i, i + 500)),
          inArray(observation.metric, [...input.metrics]),
          ...(input.from ? [gte(observation.observedOn, input.from)] : []),
          ...(input.to ? [lte(observation.observedOn, input.to)] : []),
        ),
      )
      .orderBy(asc(observation.observedOn))
    for (const row of rows) {
      const key = `${row.entityId}|${row.metric}|${row.observedOn}`
      const list = grouped.get(key) ?? []
      list.push(toSourceValue(row, disqualified))
      grouped.set(key, list)
    }
  }
  for (const [key, values] of grouped) {
    const [entityId, metric, observedOn] = key.split('|') as [string, string, string]
    const ranked = rankValues(values, priorities.get(metric) ?? [])
    const byMetric = result.get(entityId) ?? new Map<string, MetricPoint[]>()
    const series = byMetric.get(metric) ?? []
    series.push({
      observedOn,
      primary: ranked[0] as SourceValue,
      values: ranked,
      dispersion: dispersionOf(ranked),
    })
    byMetric.set(metric, series)
    result.set(entityId, byMetric)
  }
  // 分批读取后按日期重新排序
  for (const byMetric of result.values()) {
    for (const series of byMetric.values())
      series.sort((a, b) => a.observedOn.localeCompare(b.observedOn))
  }
  return result
}
