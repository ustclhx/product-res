import type {
  LogisticsType,
  MissingInput,
  Platform,
  UnavailableReason,
  WaterfallStep,
} from '@product-res/costing'
import type { DecisionRow, LogisticsProfileRow } from '@product-res/db'

// 客户端也会引用这些取值，不能 import @product-res/db 的运行时代码；用 satisfies 与 schema 枚举对齐。
export const COSTING_PLATFORMS = ['amazon', 'ebay'] as const satisfies readonly Platform[]
export const LOGISTICS_TYPES = [
  'ebay-direct',
  'ebay-overseas',
  'amazon-fba',
  'amazon-fbm',
] as const satisfies readonly LogisticsProfileRow['type'][]
export const DROP_REASONS = [
  'low-margin',
  'competition',
  'timing',
  'supply',
  'infringement',
  'other',
] as const satisfies readonly NonNullable<DecisionRow['dropReason']>[]
export type DropReason = (typeof DROP_REASONS)[number]

export const PLATFORM_LABELS: Record<Platform, string> = { amazon: 'Amazon', ebay: 'eBay' }

export const LOGISTICS_TYPE_LABELS: Record<LogisticsType, string> = {
  'ebay-direct': 'eBay 直发',
  'ebay-overseas': 'eBay 海外仓',
  'amazon-fba': 'Amazon FBA 头程',
  'amazon-fbm': 'Amazon FBM 直发',
}

/** 每种物流类型所属平台与需要的公式：海外仓 / FBA 要头程，FBA 以外要直发运费或尾程 */
export const LOGISTICS_TYPE_RULES: Record<
  LogisticsType,
  { platform: Platform; headFreight: boolean; lastMile: boolean }
> = {
  'ebay-direct': { platform: 'ebay', headFreight: false, lastMile: true },
  'ebay-overseas': { platform: 'ebay', headFreight: true, lastMile: true },
  'amazon-fba': { platform: 'amazon', headFreight: true, lastMile: false },
  'amazon-fbm': { platform: 'amazon', headFreight: false, lastMile: true },
}

export const DROP_REASON_LABELS: Record<DropReason, string> = {
  'low-margin': '利润不够',
  competition: '竞争太多',
  timing: '时间来不及',
  supply: '货源不行',
  infringement: '侵权风险',
  other: '其他',
}

export const FOLLOW_MODE_LABELS = { 'same-source': '同款同货源', improved: '同款微改良' } as const

/** 线索决定后不可再改核算（design D4）：followed / dropped 为终态 */
export const DECIDED_LEAD_STATUSES = ['followed', 'dropped'] as const
export function isLeadDecided(status: string): boolean {
  return (DECIDED_LEAD_STATUSES as readonly string[]).includes(status)
}

export const SUPPLIER_PLATFORM_LABELS = {
  '1688': '1688',
  alibaba: 'Alibaba',
  other: '其他',
} as const
export const QUOTE_CONFIDENCE_LABELS = { public: '公开价', confirmed: '已确认报价' } as const

/** 矩阵格“缺少：…”的输入名称 */
export const MISSING_INPUT_LABELS: Record<MissingInput, string> = {
  salePrice: '售价',
  unitPrice: '单价',
  weight: '重量',
  dimensions: '尺寸',
  fxRate: '汇率',
  commissionRate: '佣金率',
  fixedFee: '固定费',
  adRate: '广告率',
  returnRate: '退货预留率',
  headFreight: '头程公式',
  lastMile: '运费 / 尾程公式',
  fulfillmentFee: 'FBA 配送费',
  storageFee: '仓储费',
  inboundFee: '入库配置费',
  improvement: '微改良参数',
  procurementDays: '采购天数',
  sampleDays: '打样天数',
  listingPrepDays: '上架准备天数',
  inboundDays: 'FBA 入库天数',
}

export const UNAVAILABLE_LABELS: Record<UnavailableReason, string> = {
  'below-moq': '低于 MOQ',
  'shipping-ban': '禁运',
  'too-late': '来不及',
  'missing-input': '缺少输入',
}

/** 成本瀑布 7 步（blockers D3：仓储与入库费并入配送/尾程，改款费分摊并入采购） */
export const WATERFALL_LABELS: Record<WaterfallStep['key'], string> = {
  purchase: '采购',
  headFreight: '头程',
  platformFee: '平台费',
  fulfillment: '配送/尾程',
  ads: '广告',
  returns: '退货预留',
  netProfit: '净利润',
}

/** 跟卖后回看天数（specs/selection-archive「30 天回看」） */
export const REVIEW_DAYS = 30
