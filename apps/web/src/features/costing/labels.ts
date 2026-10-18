import type { LogisticsType, Platform } from '@product-res/costing'
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

/** 跟卖后回看天数（specs/selection-archive「30 天回看」） */
export const REVIEW_DAYS = 30
