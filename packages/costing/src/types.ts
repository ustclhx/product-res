/**
 * 核算输入输出类型。金额一律为最小单位整数（如美分）并带显式币种；比例用小数（0.15 = 15%）。
 * 可空字段表示“未录入”，核算时报告缺失而不是当作 0；明确录入的 0 是合法值。
 */

/** ISO 4217 币种代码，如 USD / CNY */
export type Currency = string

export type Money = { amountMinor: number; currency: Currency }

/** 1 单位 from = rate 单位 to（主单位之比，与最小单位位数无关） */
export type FxRate = { from: Currency; to: Currency; rate: number }

export type Platform = 'amazon' | 'ebay'

/** same-source 同款同货源；improved 同款微改良 */
export type FollowMode = 'same-source' | 'improved'

/** 核算所需、可能缺失的输入 */
export type MissingInput =
  | 'salePrice'
  | 'unitPrice'
  | 'weight'
  | 'dimensions'
  | 'fxRate'
  | 'commissionRate'
  | 'fixedFee'
  | 'adRate'
  | 'returnRate'
  | 'headFreight'
  | 'lastMile'
  | 'fulfillmentFee'
  | 'storageFee'
  | 'inboundFee'
  | 'improvement'
  | 'procurementDays'
  | 'sampleDays'
  | 'listingPrepDays'
  | 'inboundDays'

export type Missing = { status: 'missing'; missing: MissingInput[] }

export type PriceTier = { minQty: number; unitPriceMinor: number }

export type Dimensions = { lengthCm: number; widthCm: number; heightCm: number }

/** public 公开价；confirmed 已确认报价 */
export type QuoteConfidence = 'public' | 'confirmed'

export type SupplierQuote = {
  id: string
  currency: Currency
  tiers: PriceTier[]
  moq?: number | null
  /** 单件实重（克） */
  weightG?: number | null
  /** 单件包装尺寸 */
  dimensions?: Dimensions | null
  confidence: QuoteConfidence
  /** 报价给出的采购（生产 + 发货）天数 */
  procurementDays?: number | null
}

/**
 * 计费公式：
 * - first-additional 首重续重；设置 volumetricDivisor 时计费重量取实重与体积重较大者
 * - volume 按方（立方米）计费
 */
export type ShippingFormula =
  | {
      kind: 'first-additional'
      currency: Currency
      firstWeightG: number
      firstPriceMinor: number
      stepWeightG: number
      stepPriceMinor: number
      /** 体积重系数，如 6000（cm³/kg）；不设则只按实重 */
      volumetricDivisor?: number
    }
  | {
      kind: 'volume'
      currency: Currency
      pricePerCbmMinor: number
      /** 最低计费方数 */
      minCbm?: number
    }

export type LogisticsType = 'ebay-direct' | 'ebay-overseas' | 'amazon-fba' | 'amazon-fbm'

export type LogisticsProfile = {
  id: string
  platform: Platform
  type: LogisticsType
  /** 物流时长（天）：直发为到买家，海外仓 / FBA 为头程到仓 */
  transitDays: number
  /** 头程（整批计费后按数量分摊），海外仓与 FBA 必需 */
  headFreight?: ShippingFormula | null
  /** 直发运费或海外仓尾程（按单件计费），FBA 以外必需 */
  lastMile?: ShippingFormula | null
  /** 禁运属性，如 battery / liquid */
  bannedAttributes?: string[]
}

/** 平台 × 类目的成本参数（已完成类目回退） */
export type CostParams = {
  commissionRate?: number | null
  /** 单笔固定费，币种同售价 */
  fixedFeeMinor?: number | null
  adRate?: number | null
  returnRate?: number | null
  /** 单件月仓储费（FBA 月仓储 / 海外仓仓租），币种同售价 */
  storageMonthlyMinor?: number | null
  /** 预计库存月数 */
  storageMonths?: number | null
  /** 单件入库配置费（Amazon FBA），币种同售价 */
  inboundFeeMinor?: number | null
}

/** FBA 配送费：SP-API 预估优先，取不到时用费率表 */
export type FulfillmentFee = Money & { source: 'sp-api' | 'rate-table' }

/** 微改良：单价加成比例与一次性改款费（按计划数量分摊） */
export type Improvement = {
  unitSurchargeRate: number
  toolingCost: Money
  sampleDays?: number | null
}

export type CostingInput = {
  plannedQty: number
  /** 售价，默认取竞品中位价；决定核算输出币种 */
  salePrice: Money | null
  quote: SupplierQuote
  profile: LogisticsProfile
  mode: FollowMode
  improvement?: Improvement | null
  costParams: CostParams
  /** Amazon FBA 必需 */
  fulfillmentFee?: FulfillmentFee | null
  fxRates: FxRate[]
}

/** 单件成本项（售价币种最小单位） */
export type CostBreakdown = {
  purchaseMinor: number
  headFreightMinor: number
  platformFeeMinor: number
  fulfillmentMinor: number
  storageMinor: number
  adsMinor: number
  returnsMinor: number
  /** 改款费分摊 */
  modificationMinor: number
}

export type WaterfallStep = {
  key: 'purchase' | 'headFreight' | 'platformFee' | 'fulfillment' | 'ads' | 'returns' | 'netProfit'
  amountMinor: number
}

export type CostingResult = {
  status: 'ok'
  currency: Currency
  salePriceMinor: number
  /** 阶梯单价（报价币种） */
  unitPrice: Money
  /** 计费重量（克，单件）；按方计费或无重量公式时为 null */
  chargeableWeightG: number | null
  /** 物流公式需要体积重但报价缺尺寸，已按实重计费（降低成本确定性） */
  dimensionsMissing: boolean
  costs: CostBreakdown
  /** 采购 + 头程 + 配送/尾程 + 仓储 + 改款费分摊 */
  landedCostMinor: number
  netProfitMinor: number
  /** 净利润 ÷ 售价 */
  grossMargin: number
  /** 费率和 ≥ 1 时无解为 null */
  breakEvenMinor: number | null
  fulfillmentSource: FulfillmentFee['source'] | 'profile' | null
  waterfall: WaterfallStep[]
}

export type CostingOutcome = CostingResult | Missing
