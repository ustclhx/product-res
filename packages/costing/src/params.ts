import type { CostParams } from './types.ts'

export type ParamSource = 'category' | 'platform-default' | 'missing'

const KEYS = [
  'commissionRate',
  'fixedFeeMinor',
  'adRate',
  'returnRate',
  'storageMonthlyMinor',
  'storageMonths',
  'inboundFeeMinor',
] as const satisfies readonly (keyof CostParams)[]

/**
 * 类目回退：逐项取类目值，类目未配置（null/undefined）时取平台默认，并标注来源供核算明细展示。
 */
export function resolveCostParams(
  platformDefault: CostParams,
  category?: CostParams | null,
): { params: CostParams; sources: Record<keyof CostParams, ParamSource> } {
  const params: CostParams = {}
  const sources = {} as Record<keyof CostParams, ParamSource>
  for (const key of KEYS) {
    const own = category?.[key]
    const fallback = platformDefault[key]
    if (own != null) {
      params[key] = own
      sources[key] = 'category'
    } else if (fallback != null) {
      params[key] = fallback
      sources[key] = 'platform-default'
    } else {
      sources[key] = 'missing'
    }
  }
  return { params, sources }
}
