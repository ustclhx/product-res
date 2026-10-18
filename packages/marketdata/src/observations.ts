import type {
  AcquisitionMethod,
  EntityKey,
  Marketplace,
  NormalizedEntity,
  NormalizedObservation,
} from '@product-res/datasources'
import type { Database } from '@product-res/db'
import {
  marketplaceKeyword,
  marketplaceProduct,
  marketplaceSeller,
  metricPriority,
  observation,
} from '@product-res/db/schema'
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

/** 实体自然键的字符串形式 */
export const entityRef = (key: EntityKey) => `${key.type}:${key.marketplace}:${key.platformId}`

/** 类目、币种等没有独立表的实体：用自然键派生稳定的 UUID 形状 ID */
export async function derivedEntityId(key: EntityKey) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entityRef(key))),
  )
  const h = [...digest.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .split('')
  // 版本位 8（自定义 UUID），变体位 10xx
  h[12] = '8'
  h[16] = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)
  const hex = h.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const toDate = (value: string | undefined) => {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * 写入实体并返回 自然键 → ID。不同数据源返回的同一实体归到同一记录；
 * 新值只补充或更新非空字段，不用空值覆盖已有信息。
 */
export async function upsertEntities(db: Database, entities: readonly NormalizedEntity[]) {
  const ids = new Map<string, string>()
  const unique = new Map<string, NormalizedEntity>()
  for (const entity of entities) unique.set(entityRef(entity.key), entity)
  const products = [...unique.values()].filter((e) => e.key.type === 'product')
  if (products.length > 0) {
    const rows = await db
      .insert(marketplaceProduct)
      .values(
        products.map((e) => ({
          marketplace: e.key.marketplace,
          platformId: e.key.platformId,
          title: e.facts?.title,
          brand: e.facts?.brand,
          gtin: e.facts?.gtin,
          categoryId: e.facts?.categoryId,
          imageUrl: e.facts?.imageUrl,
          url: e.facts?.url,
          sellerId: e.facts?.sellerId,
          listedAt: toDate(e.facts?.listedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [marketplaceProduct.marketplace, marketplaceProduct.platformId],
        set: {
          title: sql`coalesce(excluded.title, ${marketplaceProduct.title})`,
          brand: sql`coalesce(excluded.brand, ${marketplaceProduct.brand})`,
          gtin: sql`coalesce(excluded.gtin, ${marketplaceProduct.gtin})`,
          categoryId: sql`coalesce(excluded.category_id, ${marketplaceProduct.categoryId})`,
          imageUrl: sql`coalesce(excluded.image_url, ${marketplaceProduct.imageUrl})`,
          url: sql`coalesce(excluded.url, ${marketplaceProduct.url})`,
          sellerId: sql`coalesce(excluded.seller_id, ${marketplaceProduct.sellerId})`,
          listedAt: sql`coalesce(excluded.listed_at, ${marketplaceProduct.listedAt})`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: marketplaceProduct.id,
        marketplace: marketplaceProduct.marketplace,
        platformId: marketplaceProduct.platformId,
      })
    for (const row of rows) ids.set(`product:${row.marketplace}:${row.platformId}`, row.id)
  }
  const sellers = [...unique.values()].filter((e) => e.key.type === 'seller')
  if (sellers.length > 0) {
    const rows = await db
      .insert(marketplaceSeller)
      .values(
        sellers.map((e) => ({ marketplace: e.key.marketplace, platformId: e.key.platformId })),
      )
      .onConflictDoUpdate({
        target: [marketplaceSeller.marketplace, marketplaceSeller.platformId],
        set: { updatedAt: sql`now()` },
      })
      .returning({
        id: marketplaceSeller.id,
        marketplace: marketplaceSeller.marketplace,
        platformId: marketplaceSeller.platformId,
      })
    for (const row of rows) ids.set(`seller:${row.marketplace}:${row.platformId}`, row.id)
  }
  const keywords = [...unique.values()].filter((e) => e.key.type === 'keyword')
  if (keywords.length > 0) {
    const rows = await db
      .insert(marketplaceKeyword)
      .values(
        keywords.map((e) => ({
          marketplace: e.key.marketplace,
          phrase: normalizePhrase(e.key.platformId),
        })),
      )
      .onConflictDoUpdate({
        target: [marketplaceKeyword.marketplace, marketplaceKeyword.phrase],
        set: { phrase: sql`excluded.phrase` },
      })
      .returning({
        id: marketplaceKeyword.id,
        marketplace: marketplaceKeyword.marketplace,
        phrase: marketplaceKeyword.phrase,
      })
    const byPhrase = new Map(rows.map((r) => [`${r.marketplace}:${r.phrase}`, r.id]))
    for (const e of keywords) {
      const id = byPhrase.get(`${e.key.marketplace}:${normalizePhrase(e.key.platformId)}`)
      if (id) ids.set(entityRef(e.key), id)
    }
  }
  for (const entity of unique.values())
    if (!ids.has(entityRef(entity.key)))
      ids.set(entityRef(entity.key), await derivedEntityId(entity.key))
  return ids
}

export const normalizePhrase = (phrase: string) => phrase.trim().toLowerCase().replace(/\s+/g, ' ')

export interface ObservationOrigin {
  readonly sourceId: string
  readonly fetchedAt: Date
  readonly rawPayloadId?: string
  readonly importId?: string
}

/**
 * 写入观测值：同一实体、指标、日期、来源重复写入以最新一次为准；不同来源并存。
 * 观测引用的实体必须已在 ids 中（先调用 upsertEntities）。
 */
export async function upsertObservations(
  db: Database,
  rows: readonly NormalizedObservation[],
  ids: ReadonlyMap<string, string>,
  origin: ObservationOrigin,
) {
  if (rows.length === 0) return 0
  // 同一批内的重复以最后一条为准，避免 ON CONFLICT 同批冲突
  const dedup = new Map<string, NormalizedObservation>()
  for (const row of rows) dedup.set(`${entityRef(row.entity)}|${row.metric}|${row.observedOn}`, row)
  const values = [...dedup.values()].map((row) => {
    const entityId = ids.get(entityRef(row.entity))
    if (!entityId) throw new Error(`Entity not upserted: ${entityRef(row.entity)}`)
    return {
      entityType: row.entity.type,
      entityId,
      metric: row.metric,
      observedOn: row.observedOn,
      sourceId: origin.sourceId,
      value: row.value,
      currency: row.currency ?? null,
      method: row.method,
      rawPayloadId: origin.rawPayloadId ?? null,
      importId: origin.importId ?? null,
      fetchedAt: origin.fetchedAt,
    }
  })
  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(observation)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [
          observation.entityType,
          observation.entityId,
          observation.metric,
          observation.observedOn,
          observation.sourceId,
        ],
        set: {
          value: sql`excluded.value`,
          currency: sql`excluded.currency`,
          method: sql`excluded.method`,
          rawPayloadId: sql`excluded.raw_payload_id`,
          importId: sql`excluded.import_id`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      })
  }
  return values.length
}

export interface SourceValue {
  readonly sourceId: string
  readonly value: number
  readonly currency: string | null
  readonly method: AcquisitionMethod
  readonly fetchedAt: Date
  readonly rawPayloadId: string | null
  readonly importId: string | null
}

export interface MetricPoint {
  readonly observedOn: string
  /** 优先级最高且有值的来源 */
  readonly primary: SourceValue
  /** 全部来源，按优先级排序 */
  readonly values: readonly SourceValue[]
  /** 来源间离散度：(max − min) ÷ min；只有一个来源时为 null（未交叉验证） */
  readonly dispersion: number | null
}

/** 默认来源优先级（add-source-connectors design D9）；团队可在数据中心修改 */
export const DEFAULT_PRIORITIES: Readonly<Record<string, readonly string[]>> = {
  sales_estimate_monthly: ['jungle-scout', 'sellersprite', 'helium10', 'keepa'],
  price: ['amazon-spapi', 'keepa', 'dataforseo', 'ebay-browse'],
  seller_count: ['amazon-spapi', 'keepa', 'dataforseo'],
  bsr: ['keepa', 'amazon-spapi'],
  // 手填汇率优先于公开来源（specs/connector-fx「人工覆盖」）
  fx_rate: ['manual', 'fx-ecb'],
  search_volume_monthly: ['sellersprite', 'jungle-scout', 'helium10', 'dataforseo'],
}

export async function getPriority(db: Database, marketplace: Marketplace, metric: string) {
  const [row] = await db
    .select()
    .from(metricPriority)
    .where(and(eq(metricPriority.marketplace, marketplace), eq(metricPriority.metric, metric)))
  return row?.sources ?? DEFAULT_PRIORITIES[metric] ?? []
}

export async function setPriority(
  db: Database,
  marketplace: Marketplace,
  metric: string,
  sources: string[],
) {
  await db
    .insert(metricPriority)
    .values({ marketplace, metric, sources })
    .onConflictDoUpdate({
      target: [metricPriority.marketplace, metricPriority.metric],
      set: { sources, updatedAt: sql`now()` },
    })
}

/** 按优先级排序：列在优先级中的按顺序，未列出的按获取时间倒序排在后面 */
export function rankValues(values: readonly SourceValue[], priority: readonly string[]) {
  const rank = (id: string) => {
    const index = priority.indexOf(id)
    return index < 0 ? priority.length : index
  }
  return [...values].sort(
    (a, b) => rank(a.sourceId) - rank(b.sourceId) || b.fetchedAt.getTime() - a.fetchedAt.getTime(),
  )
}

export function dispersionOf(values: readonly SourceValue[]) {
  if (values.length < 2) return null
  const nums = values.map((v) => v.value)
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  if (min <= 0) return max === min ? 0 : null
  return (max - min) / min
}

/**
 * 读取某实体某指标的时间序列：每天返回主值、全部来源值与离散度。
 * 没有观测的日期不出现在结果中（“无数据”与“值为 0”不同）。
 */
export async function readMetric(
  db: Database,
  input: {
    readonly entityType: EntityKey['type']
    readonly entityId: string
    readonly metric: string
    readonly marketplace: Marketplace
    readonly from?: string
    readonly to?: string
  },
): Promise<MetricPoint[]> {
  const rows = await db
    .select()
    .from(observation)
    .where(
      and(
        eq(observation.entityType, input.entityType),
        eq(observation.entityId, input.entityId),
        eq(observation.metric, input.metric),
        ...(input.from ? [gte(observation.observedOn, input.from)] : []),
        ...(input.to ? [lte(observation.observedOn, input.to)] : []),
      ),
    )
    .orderBy(asc(observation.observedOn))
  return toPoints(rows, await getPriority(db, input.marketplace, input.metric))
}

/** 已按日期升序的观测行 → 每日主值、全部来源与离散度 */
function toPoints(rows: readonly (typeof observation.$inferSelect)[], priority: readonly string[]) {
  const byDay = new Map<string, SourceValue[]>()
  for (const row of rows) {
    const list = byDay.get(row.observedOn) ?? []
    list.push({
      sourceId: row.sourceId,
      value: row.value,
      currency: row.currency,
      method: row.method,
      fetchedAt: row.fetchedAt,
      rawPayloadId: row.rawPayloadId,
      importId: row.importId,
    })
    byDay.set(row.observedOn, list)
  }
  return [...byDay.entries()].map(([observedOn, values]): MetricPoint => {
    const ranked = rankValues(values, priority)
    return {
      observedOn,
      primary: ranked[0] as SourceValue,
      values: ranked,
      dispersion: dispersionOf(ranked),
    }
  })
}

/**
 * 批量读取多个实体、多个指标的时间序列（详情页与列表一次取完，避免逐个实体查询）。
 * 返回 实体 ID → 指标 → 序列；没有观测的实体或指标不出现在结果中。
 */
export async function readMetrics(
  db: Database,
  input: {
    readonly entityType: EntityKey['type']
    readonly entityIds: readonly string[]
    readonly metrics: readonly string[]
    readonly marketplace: Marketplace
    readonly from?: string
    readonly to?: string
  },
): Promise<Map<string, Map<string, MetricPoint[]>>> {
  const result = new Map<string, Map<string, MetricPoint[]>>()
  if (input.entityIds.length === 0 || input.metrics.length === 0) return result
  const rows = await db
    .select()
    .from(observation)
    .where(
      and(
        eq(observation.entityType, input.entityType),
        inArray(observation.entityId, [...input.entityIds]),
        inArray(observation.metric, [...input.metrics]),
        ...(input.from ? [gte(observation.observedOn, input.from)] : []),
        ...(input.to ? [lte(observation.observedOn, input.to)] : []),
      ),
    )
    .orderBy(asc(observation.observedOn))
  const priorities = new Map(
    await Promise.all(
      input.metrics.map(
        async (metric) => [metric, await getPriority(db, input.marketplace, metric)] as const,
      ),
    ),
  )
  const grouped = new Map<string, Map<string, (typeof rows)[number][]>>()
  for (const row of rows) {
    const byMetric = grouped.get(row.entityId) ?? new Map()
    byMetric.set(row.metric, [...(byMetric.get(row.metric) ?? []), row])
    grouped.set(row.entityId, byMetric)
  }
  for (const [entityId, byMetric] of grouped) {
    const series = new Map<string, MetricPoint[]>()
    for (const [metric, list] of byMetric)
      series.set(metric, toPoints(list, priorities.get(metric) ?? []))
    result.set(entityId, series)
  }
  return result
}

/** 批量取实体 ID（数据中心预览、质量检查使用） */
export async function productIds(
  db: Database,
  marketplace: Marketplace,
  platformIds: readonly string[],
) {
  if (platformIds.length === 0) return new Map<string, string>()
  const rows = await db
    .select({ id: marketplaceProduct.id, platformId: marketplaceProduct.platformId })
    .from(marketplaceProduct)
    .where(
      and(
        eq(marketplaceProduct.marketplace, marketplace),
        inArray(marketplaceProduct.platformId, [...platformIds]),
      ),
    )
  return new Map(rows.map((r) => [r.platformId, r.id]))
}

/**
 * 某日（含）之前最近一个有值的观测，用于汇率等“当日缺失则沿用最近一日”的场景；
 * 返回实际使用的日期，调用方必须展示它（specs/connector-fx「获取失败」）。
 */
export async function latestValue(
  db: Database,
  input: {
    readonly entity: EntityKey
    readonly metric: string
    readonly onOrBefore: string
  },
) {
  const ids = await upsertEntities(db, [{ key: input.entity }])
  const entityId = ids.get(entityRef(input.entity)) as string
  const points = await readMetric(db, {
    entityType: input.entity.type,
    entityId,
    metric: input.metric,
    marketplace: input.entity.marketplace,
    to: input.onOrBefore,
  })
  const last = points.at(-1)
  return last ? { observedOn: last.observedOn, ...last.primary } : null
}

/** 人工填写某日汇率：来源 manual、获取方式“手工导入”，优先于公开来源；公开来源的值保留 */
export async function setManualRate(
  db: Database,
  input: {
    readonly pair: string
    readonly observedOn: string
    readonly value: number
    readonly now: Date
  },
) {
  const entity = {
    type: 'currency' as const,
    marketplace: 'global' as const,
    platformId: input.pair,
  }
  const ids = await upsertEntities(db, [{ key: entity }])
  await upsertObservations(
    db,
    [
      {
        entity,
        metric: 'fx_rate',
        observedOn: input.observedOn,
        value: input.value,
        method: 'import',
      },
    ],
    ids,
    { sourceId: 'manual', fetchedAt: input.now },
  )
}
