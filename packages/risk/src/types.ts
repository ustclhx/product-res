export type RiskType =
  | 'brand'
  | 'vero'
  | 'brand-registry'
  | 'design-patent'
  | 'image-copyright'
  | 'restricted-category'
  | 'certification'
  | 'hazmat'
  | 'shipping-ban'

export type RiskLevel = 'high' | 'medium' | 'low' | 'info'

/** same-source 同款同货源；improved 同款微改良 */
export type FollowMode = 'same-source' | 'improved'

export type RiskProduct = {
  platform: 'amazon' | 'ebay'
  brand?: string | null
  title: string
  categoryId?: string | null
  /** Amazon 品牌备案 */
  brandRegistered?: boolean
  /** 同簇主卖家数 */
  mainSellerCount?: number
  sellerHasBrandStore?: boolean
  /** 商品属性，如 battery / liquid / children */
  attributes?: string[]
  /** 是否在他人现有 ASIN 下直接跟卖（Amazon）；默认由跟卖方式决定（same-source 为 true） */
  listingOnExistingAsin?: boolean
}

export type BrandEntry = {
  brand: string
  kind: 'brand' | 'vero' | 'registered'
}

export type RiskRule = {
  type: 'restricted-category' | 'certification' | 'hazmat' | 'shipping-ban'
  /** 匹配条件：categoryIds 与 attributes 任一命中即触发；platform 为空表示不限 */
  match: {
    platform?: 'amazon' | 'ebay'
    categoryIds?: string[]
    attributes?: string[]
  }
  level: Exclude<RiskLevel, 'info'>
  note: string
  veto?: boolean
}

export type RiskFinding = {
  type: RiskType
  level: RiskLevel
  basis: string
  veto: boolean
  link?: string
}

export type RiskInput = {
  product: RiskProduct
  mode: FollowMode
  brands: BrandEntry[]
  rules: RiskRule[]
  /** 物流方案的禁运属性 */
  shippingBans?: string[]
}

export type RiskResult = {
  findings: RiskFinding[]
  /** 100 − 扣分；任一 veto 时为 0 */
  complianceScore: number
}
