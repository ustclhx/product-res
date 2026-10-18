import type { EntityType } from './types.ts'

/**
 * 指标目录：统一的指标名、单位和适用实体（design D6）。
 * 连接器与导入只能写入这里登记的指标；新增指标在此登记。
 */
export interface MetricDefinition {
  readonly label: string
  readonly unit: 'count' | 'money' | 'rank' | 'ratio' | 'index' | 'rate'
  readonly entity: EntityType
}

export const METRICS = {
  price: { label: '价格', unit: 'money', entity: 'product' },
  shipping_price: { label: '运费', unit: 'money', entity: 'product' },
  available_quantity: { label: '可售量', unit: 'count', entity: 'product' },
  sold_quantity_total: { label: '累计已售', unit: 'count', entity: 'product' },
  sold_quantity_daily: { label: '日销量', unit: 'count', entity: 'product' },
  sales_estimate_monthly: { label: '月销量估算', unit: 'count', entity: 'product' },
  revenue_estimate_monthly: { label: '月销售额估算', unit: 'money', entity: 'product' },
  bsr: { label: 'BSR 排名', unit: 'rank', entity: 'product' },
  rating: { label: '评分', unit: 'index', entity: 'product' },
  review_count: { label: '评论数', unit: 'count', entity: 'product' },
  seller_count: { label: '卖家数', unit: 'count', entity: 'product' },
  buybox_price: { label: 'Buy Box 价', unit: 'money', entity: 'product' },
  listing_count: { label: '在售商品数', unit: 'count', entity: 'seller' },
  search_volume_monthly: { label: '月搜索量', unit: 'count', entity: 'keyword' },
  search_trend_index: { label: '搜索趋势指数', unit: 'index', entity: 'keyword' },
  fx_rate: { label: '汇率', unit: 'rate', entity: 'currency' },
} as const satisfies Record<string, MetricDefinition>

export type MetricName = keyof typeof METRICS

export function isMetric(name: string): name is MetricName {
  return Object.hasOwn(METRICS, name)
}
