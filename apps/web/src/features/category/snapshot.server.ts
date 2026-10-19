import type { Marketplace } from '@product-res/datasources'
import {
  type CategoryStudy,
  type Database,
  marketplaceKeyword,
  marketplaceProduct,
  marketplaceReview,
  observation,
} from '@product-res/db'
import {
  addMonths,
  competitorMatrix,
  concentration,
  countNewProducts,
  type InsightProduct,
  type InsightReview,
  type MonthlyValue,
  monthlyTrend,
  priceBands,
  reviewTerms,
  searchVolumeYoy,
  selectNegativeReviews,
  type TrendNode,
} from '@product-res/insight'
import { dispersionOf, getPriority, normalizePhrase, rankValues } from '@product-res/marketdata'
import { and, desc, eq, gte, ilike, inArray, or, type SQL } from 'drizzle-orm'
import { buildInsightPrompt, type InsightAi, insightFingerprint } from './ai.ts'
import { newAnalysisJob, type PendingAnalysis, runningState } from './analysis.server.ts'
import type {
  AiMeta,
  MatrixRowView,
  ReviewView,
  SnapshotModules,
  SourcedNumber,
  SourceSummary,
} from './types.ts'

/**
 * 生成品类研究快照（tasks 3.1 / 3.3）：只读已有的市场数据与观测值，调用 packages/insight 聚合，
 * 不发起任何外部采集；数据不足时由数据中心人工刷新（遵守额度，design D3）。
 * 市场数据是部署级表，不经 scoped()；空间数据（节点、上一份快照）由调用方读取后传入。
 */

const PRODUCT_LIMIT = 2000
const REVIEW_LIMIT = 3000
/** 交给 AI 的差评条数与正文长度上限，控制单次调用的 token */
const AI_REVIEW_LIMIT = 120
const AI_BODY_CHARS = 400
const AI_COMPETITORS = 10
const PRODUCT_METRICS = ['price', 'rating', 'review_count', 'sales_estimate_monthly'] as const
type ProductMetric = (typeof PRODUCT_METRICS)[number]

type Method = SourcedNumber['method']
interface RawPoint {
  sourceId: string
  value: number
  currency: string | null
  method: Method
  fetchedAt: Date
  rawPayloadId: string | null
  importId: string | null
}

const chunk = <T>(items: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  )

const monthOf = (day: string) => day.slice(0, 7)

/** 同一实体同一指标：按日期分组 → 优先级排序（与 readMetric 同口径） */
function toSourced(day: string, values: RawPoint[], priority: readonly string[]): SourcedNumber {
  const ranked = rankValues(values, priority)
  const primary = ranked[0] as RawPoint
  return {
    value: primary.value,
    sourceId: primary.sourceId,
    method: primary.method,
    at: primary.fetchedAt.toISOString(),
    observedOn: day,
    currency: primary.currency,
    alternatives: ranked
      .slice(1)
      .map((v) => ({ sourceId: v.sourceId, value: v.value, method: v.method })),
    dispersion: dispersionOf(ranked),
  }
}

function summarize(points: readonly { sourceId: string; method: string; at: string }[]) {
  const map = new Map<string, SourceSummary>()
  for (const p of points) {
    const s = map.get(p.sourceId)
    if (!s)
      map.set(p.sourceId, {
        sourceId: p.sourceId,
        method: p.method as Method,
        latestAt: p.at,
        points: 1,
      })
    else {
      s.points++
      if (p.at > s.latestAt) s.latestAt = p.at
    }
  }
  return [...map.values()].sort((a, b) => b.points - a.points)
}

function mostCommon(values: readonly (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** 观测值按 实体 → 指标 → 日期 分组 */
type Grouped = Map<string, Map<string, Map<string, RawPoint[]>>>

async function readObservations(
  db: Database,
  entityType: 'product' | 'keyword',
  ids: readonly string[],
  metrics: readonly string[],
  from: string,
): Promise<{ grouped: Grouped; latestDay: string | null }> {
  const grouped: Grouped = new Map()
  let latestDay: string | null = null
  for (const part of chunk(ids, 500)) {
    const rows = await db
      .select()
      .from(observation)
      .where(
        and(
          eq(observation.entityType, entityType),
          inArray(observation.entityId, part),
          inArray(observation.metric, [...metrics]),
          gte(observation.observedOn, from),
        ),
      )
    for (const r of rows) {
      const byMetric = grouped.get(r.entityId) ?? new Map()
      grouped.set(r.entityId, byMetric)
      const byDay = byMetric.get(r.metric) ?? new Map()
      byMetric.set(r.metric, byDay)
      const list = byDay.get(r.observedOn) ?? []
      byDay.set(r.observedOn, list)
      list.push({
        sourceId: r.sourceId,
        value: r.value,
        currency: r.currency,
        method: r.method,
        fetchedAt: r.fetchedAt,
        rawPayloadId: r.rawPayloadId,
        importId: r.importId,
      })
      if (latestDay === null || r.observedOn > latestDay) latestDay = r.observedOn
    }
  }
  return { grouped, latestDay }
}

/** 每个自然月取该月最后一个观测日的主值 */
function monthlySeries(
  byDay: Map<string, RawPoint[]> | undefined,
  priority: readonly string[],
): MonthlyValue[] {
  if (!byDay) return []
  const lastDay = new Map<string, string>()
  for (const day of byDay.keys()) {
    const m = monthOf(day)
    const prev = lastDay.get(m)
    if (!prev || day > prev) lastDay.set(m, day)
  }
  return [...lastDay].map(([month, day]) => {
    const s = toSourced(day, byDay.get(day) ?? [], priority)
    return { month, value: s.value, sourceId: s.sourceId, method: s.method, at: s.at }
  })
}

function latest(byDay: Map<string, RawPoint[]> | undefined, priority: readonly string[]) {
  if (!byDay || byDay.size === 0) return null
  const day = [...byDay.keys()].sort().at(-1) as string
  return toSourced(day, byDay.get(day) ?? [], priority)
}

export interface BuildSnapshotDeps {
  ai: InsightAi
  now: Date
  /** 本空间的节点日历，趋势图上标注 */
  nodes: readonly { name: string; startMonth: number; startDay: number }[]
  /** 上一份快照：差评与竞品不变时沿用其 AI 结果 */
  previous: { id: string; modules: SnapshotModules } | null
}

export async function buildSnapshot(
  db: Database,
  study: Pick<CategoryStudy, 'marketplace' | 'categoryIds' | 'keywords' | 'topN'>,
  deps: BuildSnapshotDeps,
): Promise<{
  modules: SnapshotModules
  dataAsOf: string | null
  analysis: PendingAnalysis | null
}> {
  const marketplace = study.marketplace as Marketplace
  const { now } = deps
  const nowMonth = now.toISOString().slice(0, 7)
  // 同比需要 24 个月，趋势需要 12 个月
  const from = `${addMonths(nowMonth, -25)}-01`

  // ---- 商品范围：类目命中，或标题包含任一关键词 ----
  const conditions: SQL[] = []
  if (study.categoryIds.length > 0)
    conditions.push(inArray(marketplaceProduct.categoryId, study.categoryIds))
  for (const k of study.keywords)
    conditions.push(ilike(marketplaceProduct.title, `%${k.replace(/[%_\\]/g, '\\$&')}%`))
  const products =
    conditions.length === 0
      ? []
      : await db
          .select()
          .from(marketplaceProduct)
          .where(and(eq(marketplaceProduct.marketplace, marketplace), or(...conditions)))
          .limit(PRODUCT_LIMIT)
  const productIds = products.map((p) => p.id)

  const priorities = Object.fromEntries(
    await Promise.all(
      [...PRODUCT_METRICS, 'search_volume_monthly'].map(
        async (m) => [m, await getPriority(db, marketplace, m)] as const,
      ),
    ),
  ) as Record<ProductMetric | 'search_volume_monthly', readonly string[]>

  const productObs = await readObservations(db, 'product', productIds, PRODUCT_METRICS, from)

  // ---- 关键词搜索量 ----
  const phrases = [...new Set(study.keywords.map(normalizePhrase).filter(Boolean))]
  const keywordRows =
    phrases.length === 0
      ? []
      : await db
          .select()
          .from(marketplaceKeyword)
          .where(
            and(
              eq(marketplaceKeyword.marketplace, marketplace),
              inArray(marketplaceKeyword.phrase, phrases),
            ),
          )
  const keywordObs = await readObservations(
    db,
    'keyword',
    keywordRows.map((k) => k.id),
    ['search_volume_monthly'],
    from,
  )
  const searchSeries = keywordRows.flatMap((k) =>
    monthlySeries(
      keywordObs.grouped.get(k.id)?.get('search_volume_monthly'),
      priorities.search_volume_monthly,
    ),
  )
  const keywordsFound = keywordRows
    .filter((k) => keywordObs.grouped.get(k.id)?.has('search_volume_monthly'))
    .map((k) => k.phrase)

  // ---- 商品指标 ----
  const sourced = new Map<string, Partial<Record<ProductMetric, SourcedNumber>>>()
  const salesSeries: MonthlyValue[] = []
  for (const p of products) {
    const byMetric = productObs.grouped.get(p.id)
    const values: Partial<Record<ProductMetric, SourcedNumber>> = {}
    for (const m of PRODUCT_METRICS) {
      const v = latest(byMetric?.get(m), priorities[m])
      if (v) values[m] = v
    }
    sourced.set(p.id, values)
    salesSeries.push(
      ...monthlySeries(byMetric?.get('sales_estimate_monthly'), priorities.sales_estimate_monthly),
    )
  }
  const insightProducts: InsightProduct[] = products.map((p) => {
    const v = sourced.get(p.id) ?? {}
    return {
      id: p.id,
      title: p.title,
      listedAt: p.listedAt?.toISOString() ?? null,
      firstSeenAt: p.firstSeenAt.toISOString(),
      price: v.price ?? null,
      rating: v.rating ?? null,
      reviewCount: v.review_count ?? null,
      salesMonthly: v.sales_estimate_monthly ?? null,
    }
  })
  const priceCurrency = mostCommon([...sourced.values()].map((v) => v.price?.currency))

  const noProducts = (what: string) => ({
    status: 'no-source' as const,
    reason:
      products.length === 0
        ? '市场数据中没有匹配该站点、类目或关键词的商品'
        : `匹配的商品都没有${what}观测值`,
  })

  // ---- 概览 ----
  const yoy = searchVolumeYoy(searchSeries)
  const usedMonths = yoy ? new Set(yoy.months.flatMap((m) => [m, addMonths(m, -12)])) : null
  const newProducts = countNewProducts(insightProducts, { now })
  const bands = priceBands(insightProducts)
  const cr = concentration(insightProducts)
  const crossChecked = [...sourced.values()].filter(
    (v) => (v.sales_estimate_monthly?.alternatives.length ?? 0) > 0,
  ).length
  const trend = monthlyTrend(searchSeries, salesSeries, {
    endMonth: nowMonth,
    nodes: [0, -1].flatMap((dy) =>
      deps.nodes.map(
        (n): TrendNode => ({
          date: `${now.getUTCFullYear() + dy}-${String(n.startMonth).padStart(2, '0')}-${String(n.startDay).padStart(2, '0')}`,
          label: n.name,
        }),
      ),
    ),
  })
  const trendHasData = trend.some((p) => p.searchVolume !== null || p.salesEstimate !== null)
  const trendMonths = new Set(trend.map((p) => p.month))

  // ---- 竞品矩阵 ----
  const matrix = competitorMatrix(insightProducts, { topN: study.topN })
  const productById = new Map(products.map((p) => [p.id, p]))
  const rows: MatrixRowView[] = matrix.rows.map((r) => {
    const p = productById.get(r.id)
    const v = sourced.get(r.id) ?? {}
    return {
      id: r.id,
      platformId: p?.platformId ?? r.id,
      title: p?.title ?? null,
      brand: p?.brand ?? null,
      url: p?.url ?? null,
      price: v.price ?? null,
      rating: v.rating ?? null,
      reviewCount: v.review_count ?? null,
      salesMonthly: v.sales_estimate_monthly ?? null,
    }
  })

  // ---- 评论 ----
  const reviewRows =
    productIds.length === 0
      ? []
      : (
          await Promise.all(
            chunk(productIds, 500).map((part) =>
              db
                .select()
                .from(marketplaceReview)
                .where(inArray(marketplaceReview.productId, part))
                .orderBy(desc(marketplaceReview.reviewedOn), desc(marketplaceReview.id))
                .limit(REVIEW_LIMIT),
            ),
          )
        ).flat()
  const reviews: InsightReview[] = reviewRows.map((r) => ({
    id: r.id,
    productId: r.productId,
    rating: r.rating,
    title: r.title,
    body: r.body,
    date: r.reviewedOn,
    sourceId: r.sourceId,
  }))
  const negative = selectNegativeReviews(reviews, { maxBodyChars: AI_BODY_CHARS })
  const reviewViews: Record<string, ReviewView> = {}
  const cite = (id: string) => {
    if (negative.status !== 'ok' || reviewViews[id]) return
    const r = negative.items.find((i) => i.id === id)
    if (r)
      reviewViews[id] = {
        id: r.id,
        productId: r.productId,
        rating: r.rating,
        title: r.title,
        body: r.body,
        sourceId: r.sourceId,
      }
  }

  let termsModule: SnapshotModules['painPoints']['terms']
  let themes: SnapshotModules['painPoints']['themes']
  let suggestions: SnapshotModules['suggestions']
  let analysis: PendingAnalysis | null = null
  if (negative.status === 'no-source') {
    const reason = '没有评论数据来源（评论来源待接入，可在数据中心导入）'
    termsModule = { status: 'no-source', reason }
    themes = { status: 'no-source', reason }
    suggestions = { status: 'no-source', reason: '没有评论数据，无法生成有依据的差异化建议' }
  } else if (negative.items.length === 0) {
    const reason = `已有 ${negative.totalReviews} 条评论，但没有评分 ≤ 3 的差评`
    termsModule = { status: 'no-source', reason }
    themes = { status: 'no-source', reason }
    suggestions = { status: 'no-source', reason: '没有差评痛点，未生成差异化建议' }
  } else {
    const terms = reviewTerms(negative.items, { maxRefs: 3 })
    for (const t of terms) for (const id of t.reviewIds) cite(id)
    termsModule = {
      status: 'ok',
      terms,
      negativeCount: negative.negativeCount,
      totalReviews: negative.totalReviews,
      sources: [...new Set(negative.items.map((i) => i.sourceId))].sort(),
    }
    const aiReviews = negative.items.slice(0, AI_REVIEW_LIMIT)
    const competitors = rows.slice(0, AI_COMPETITORS)
    const fingerprint = await insightFingerprint(
      aiReviews.map((r) => r.id),
      competitors.map((r) => r.id),
    )
    const prev = deps.previous
    const prevThemes = prev?.modules.painPoints.themes
    const prevSuggestions = prev?.modules.suggestions
    if (
      prev &&
      prevThemes?.status === 'ok' &&
      prevSuggestions?.status === 'ok' &&
      prevThemes.ai.fingerprint === fingerprint
    ) {
      // 差评与竞品没变：沿用上一份结果，不重复调用、不重复计费
      const ai: AiMeta = { ...prevThemes.ai, reusedFrom: prevThemes.ai.reusedFrom ?? prev.id }
      themes = { ...prevThemes, ai }
      suggestions = { ...prevSuggestions, ai }
      Object.assign(reviewViews, prev.modules.reviews)
    } else {
      const resolved = await deps.ai.resolve()
      if (!resolved.ok) {
        themes = { status: 'ai-not-configured', reason: resolved.reason }
        suggestions = { status: 'ai-not-configured', reason: resolved.reason }
      } else {
        // 模型调用可能超过边缘代理的读超时：快照先以“分析中”写入，由调用方在后台执行（analysis.server.ts）
        const input = buildInsightPrompt(
          aiReviews,
          competitors.map((r) => ({
            id: r.id,
            title: r.title,
            brand: r.brand,
            price: r.price?.value ?? null,
            rating: r.rating?.value ?? null,
            salesMonthly: r.salesMonthly?.value ?? null,
          })),
        )
        const job = newAnalysisJob(fingerprint, resolved.modelKey, now)
        themes = suggestions = runningState(job)
        analysis = {
          job,
          input,
          generate: resolved.generate,
          reviewPool: aiReviews.map((r) => ({
            id: r.id,
            productId: r.productId,
            rating: r.rating,
            title: r.title,
            body: r.body,
            sourceId: r.sourceId,
          })),
        }
      }
    }
  }

  const modules: SnapshotModules = {
    version: 1,
    scope: {
      marketplace,
      categoryIds: study.categoryIds,
      keywords: study.keywords,
      keywordsFound,
      productCount: products.length,
      basis: `站点 ${marketplace} 下类目命中或标题包含任一关键词的商品（最多 ${PRODUCT_LIMIT} 个）；搜索量按研究关键词合计`,
    },
    overview: {
      yoy: yoy
        ? {
            status: 'ok',
            yoy: yoy.yoy,
            coveredMonths: yoy.coveredMonths,
            endMonth: yoy.endMonth,
            currentSum: yoy.currentSum,
            previousSum: yoy.previousSum,
            sources: summarize(searchSeries.filter((p) => usedMonths?.has(p.month))),
          }
        : {
            status: 'no-source',
            reason:
              searchSeries.length === 0
                ? '研究关键词没有月搜索量观测值'
                : '没有今年与去年同月都有数据的月份，无法计算同比',
          },
      newProducts:
        newProducts.count === null
          ? noProducts('上架或发现时间')
          : {
              status: 'ok',
              count: newProducts.count,
              windowDays: newProducts.windowDays,
              byListedAt: newProducts.byListedAt,
              byFirstSeenAt: newProducts.byFirstSeenAt,
              excluded: newProducts.excluded,
              basis: newProducts.basis,
            },
      priceBands: bands
        ? {
            status: 'ok',
            bands: bands.bands.map((b) => ({
              min: b.min,
              max: b.max,
              productCount: b.productCount,
              salesShare: b.salesShare,
            })),
            currency: priceCurrency,
            excludedNoPrice: bands.excludedNoPrice,
            missingSales: bands.missingSales,
            sources: summarize([...sourced.values()].flatMap((v) => (v.price ? [v.price] : []))),
          }
        : noProducts('价格'),
      concentration: cr
        ? {
            status: 'ok',
            cr3: cr.cr3,
            cr10: cr.cr10,
            sampleSize: cr.sampleSize,
            excluded: cr.excluded,
            // 主值来自多个来源，或有商品的销量估算同日另有来源可比对，才算交叉验证
            crossValidated: cr.crossValidated || crossChecked > 0,
            crossChecked,
            sources: summarize(
              [...sourced.values()].flatMap((v) =>
                v.sales_estimate_monthly ? [v.sales_estimate_monthly] : [],
              ),
            ),
          }
        : noProducts('月销量估算'),
    },
    trend: trendHasData
      ? {
          status: 'ok',
          points: trend,
          searchSources: summarize(searchSeries.filter((p) => trendMonths.has(p.month))),
          salesSources: summarize(salesSeries.filter((p) => trendMonths.has(p.month))),
        }
      : { status: 'no-source', reason: '近 12 个月没有搜索量或销量估算的月度观测值' },
    competitors:
      rows.length > 0
        ? {
            status: 'ok',
            rows,
            bubbles: matrix.bubbles,
            bubblesSkipped: matrix.bubblesSkipped,
            currency: priceCurrency,
          }
        : noProducts(''),
    painPoints: { terms: termsModule, themes },
    // 指标目录中没有退货率，任何连接器或导入都不提供：按 spec 显示无数据来源，不估算
    returnRate: { status: 'no-source', reason: '没有任何数据源提供退货率' },
    suggestions,
    reviews: reviewViews,
  }
  const days = [productObs.latestDay, keywordObs.latestDay].filter((d): d is string => !!d).sort()
  return { modules, dataAsOf: days.at(-1) ?? null, analysis }
}
