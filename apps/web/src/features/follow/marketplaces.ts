import type { Marketplace } from '@product-res/datasources'

/** 选品方向可选的平台站点（取值同 marketplace_product.marketplace；global 不是销售站点） */
export const DIRECTION_MARKETPLACES = [
  'ebay-us',
  'amazon-us',
  'amazon-uk',
  'amazon-de',
  'amazon-jp',
  'amazon-ca',
] as const satisfies readonly Marketplace[]
export type DirectionMarketplace = (typeof DIRECTION_MARKETPLACES)[number]

export const MARKETPLACE_LABELS: Record<DirectionMarketplace, string> = {
  'ebay-us': 'eBay US',
  'amazon-us': 'Amazon US',
  'amazon-uk': 'Amazon UK',
  'amazon-de': 'Amazon DE',
  'amazon-jp': 'Amazon JP',
  'amazon-ca': 'Amazon CA',
}

export const marketplaceLabel = (value: string) =>
  MARKETPLACE_LABELS[value as DirectionMarketplace] ?? value

/** 逗号、顿号或换行分隔的输入 → 去重去空白的列表 */
export function splitList(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}
