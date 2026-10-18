import type { BrandEntry, RiskRule } from '@product-res/db'

// 客户端也会引用这些取值，不能 import @product-res/db 的运行时代码；用 satisfies 与 schema 枚举对齐。
export const BRAND_KINDS = [
  'brand',
  'vero',
  'registered',
] as const satisfies readonly BrandEntry['kind'][]
export const RULE_KINDS = [
  'restricted-category',
  'hazmat',
  'certification',
  'shipping-ban',
] as const satisfies readonly RiskRule['kind'][]
export const RULE_LEVELS = ['high', 'medium', 'low'] as const satisfies readonly RiskRule['level'][]

export const BRAND_KIND_LABELS: Record<BrandEntry['kind'], string> = {
  brand: '品牌',
  vero: 'VeRO 权利人',
  registered: 'Amazon 品牌备案',
}
export const RULE_KIND_LABELS: Record<RiskRule['kind'], string> = {
  'restricted-category': '受限类目',
  hazmat: '危险品',
  certification: '认证要求',
  'shipping-ban': '禁运属性',
}
export const RULE_LEVEL_LABELS: Record<
  RiskRule['level'],
  { label: string; tone: 'danger' | 'warning' | 'neutral' }
> = {
  high: { label: '高', tone: 'danger' },
  medium: { label: '中', tone: 'warning' },
  low: { label: '低', tone: 'neutral' },
}
