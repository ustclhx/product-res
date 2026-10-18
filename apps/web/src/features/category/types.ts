import type { AcquisitionMethod } from '@product-res/datasources'

/**
 * 品类研究快照的模块结构（openspec/changes/add-category-insight design D2）。
 * 服务端写入 category_study_snapshot.modules，页面直接读取；所有数值都带来源，缺数据的模块只给原因、不给数值。
 */

/** 单个观测值的来源：主值 + 同日其他来源，用于“查看来源” */
export interface ValueSource {
  sourceId: string
  method: AcquisitionMethod
  /** 获取时间（ISO） */
  at: string
  observedOn: string
  currency?: string | null
  /** 同日其他来源的值（按优先级） */
  alternatives: { sourceId: string; value: number; method: AcquisitionMethod }[]
  /** 来源间离散度；只有一个来源时为 null（未交叉验证） */
  dispersion: number | null
}

export interface SourcedNumber extends ValueSource {
  value: number
}

/** 聚合值的来源汇总：参与计算的来源、获取方式与最近获取时间 */
export interface SourceSummary {
  sourceId: string
  method: AcquisitionMethod
  latestAt: string
  /** 参与的观测条数 */
  points: number
}

export type NoData = { status: 'no-source'; reason: string }
export type AiUnavailable = { status: 'ai-not-configured' | 'error' | 'skipped'; reason: string }
export type Module<T> = ({ status: 'ok' } & T) | NoData

export interface PriceBandView {
  min: number | null
  max: number | null
  productCount: number
  salesShare: number | null
}

export interface MatrixRowView {
  id: string
  platformId: string
  title: string | null
  brand: string | null
  url: string | null
  price: SourcedNumber | null
  rating: SourcedNumber | null
  reviewCount: SourcedNumber | null
  salesMonthly: SourcedNumber | null
}

export interface TrendPointView {
  month: string
  searchVolume: number | null
  salesEstimate: number | null
  nodes: { date: string; label: string }[]
}

export interface PainTheme {
  label: string
  /** 归入该主题的差评数 ÷ 参与归纳的差评数 */
  share: number
  reviewCount: number
  /** 代表评论（marketplace_review.id） */
  reviewIds: string[]
}

export interface CitationRef {
  kind: 'review' | 'product'
  id: string
}

export interface Suggestion {
  title: string
  detail: string
  citations: CitationRef[]
}

export interface ReviewView {
  id: string
  productId: string
  rating: number
  title: string
  body: string
  sourceId: string
}

export interface AiMeta {
  modelKey: string
  generatedAt: string
  /** 输入指纹：评论与竞品不变时下次刷新沿用结果，不重复计费 */
  fingerprint: string
  /** 沿用自哪份快照；为空表示本次调用生成 */
  reusedFrom: string | null
}

export interface SnapshotModules {
  version: 1
  scope: {
    marketplace: string
    categoryIds: string[]
    keywords: string[]
    /** 有搜索量记录的关键词 */
    keywordsFound: string[]
    productCount: number
    basis: string
  }
  overview: {
    yoy: Module<{
      yoy: number
      coveredMonths: number
      endMonth: string
      currentSum: number
      previousSum: number
      sources: SourceSummary[]
    }>
    newProducts: Module<{
      count: number
      windowDays: number
      byListedAt: number
      byFirstSeenAt: number
      excluded: number
      basis: string
    }>
    priceBands: Module<{
      bands: PriceBandView[]
      currency: string | null
      excludedNoPrice: number
      missingSales: number
      sources: SourceSummary[]
    }>
    concentration: Module<{
      cr3: number | null
      cr10: number | null
      sampleSize: number
      excluded: number
      crossValidated: boolean
      /** 销量估算有第二来源可比对的商品数 */
      crossChecked: number
      sources: SourceSummary[]
    }>
  }
  trend: Module<{
    points: TrendPointView[]
    searchSources: SourceSummary[]
    salesSources: SourceSummary[]
  }>
  competitors: Module<{
    rows: MatrixRowView[]
    bubbles: { id: string; x: number; y: number; size: number | null }[]
    bubblesSkipped: number
    currency: string | null
  }>
  painPoints: {
    terms: Module<{
      terms: { term: string; count: number; reviewIds: string[] }[]
      negativeCount: number
      totalReviews: number
      sources: string[]
    }>
    themes:
      | ({ status: 'ok'; themes: PainTheme[]; analyzed: number; ai: AiMeta } | AiUnavailable)
      | NoData
  }
  returnRate: NoData
  suggestions:
    | ({ status: 'ok'; items: Suggestion[]; dropped: number; ai: AiMeta } | AiUnavailable)
    | NoData
  /** 被词云、主题或建议引用的评论原文 */
  reviews: Record<string, ReviewView>
}

export const NO_SOURCE = '无数据来源'
