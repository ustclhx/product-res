/** 来源引用：每个聚合输入值都带来源、获取方式与时间，供报告“查看来源”使用。 */
export interface SourceRef {
  sourceId: string
  /** 获取方式，例如 api / import / manual */
  method: string
  /** 观测或获取时间（ISO 字符串） */
  at: string
}

export type Sourced<T> = SourceRef & { value: T }

/** 月度观测，month 形如 2026-03（UTC 月份）。 */
export interface MonthlyValue extends SourceRef {
  month: string
  value: number
}

export interface InsightProduct {
  id: string
  title?: string | null
  /** 上架时间（ISO）；缺失时新品口径退回 firstSeenAt */
  listedAt?: string | null
  firstSeenAt?: string | null
  price?: Sourced<number> | null
  rating?: Sourced<number> | null
  reviewCount?: Sourced<number> | null
  /** 月销量估算 */
  salesMonthly?: Sourced<number> | null
}

export interface InsightReview {
  id: string
  productId: string
  rating: number | null
  title?: string | null
  body?: string | null
  date?: string | null
  sourceId: string
}
