import type { CostingResult, QuoteConfidence } from './types.ts'

export type CertaintyInput = {
  quoteConfidence: QuoteConfidence
  /** 物流模板所需字段齐全（尺寸不缺） */
  logisticsComplete: boolean
  /** FBA 配送费来源；非 FBA 方案为 null，不计入平均 */
  fulfillmentFeeSource: 'sp-api' | 'rate-table' | null
}

/**
 * 成本确定性（design D3）：已确认报价 1.0、公开价 0.6；物流字段齐全 1.0、缺尺寸 0.5；
 * FBA 费来自 SP-API 1.0、费率表 0.7；取适用项的平均（非 FBA 方案没有第三项）。
 */
export function costCertainty(input: CertaintyInput): number {
  const scores = [
    input.quoteConfidence === 'confirmed' ? 1 : 0.6,
    input.logisticsComplete ? 1 : 0.5,
  ]
  if (input.fulfillmentFeeSource !== null) {
    scores.push(input.fulfillmentFeeSource === 'sp-api' ? 1 : 0.7)
  }
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** 由核算结果与报价可信度得出成本确定性 */
export function certaintyOf(result: CostingResult, quoteConfidence: QuoteConfidence): number {
  return costCertainty({
    quoteConfidence,
    logisticsComplete: !result.dimensionsMissing,
    fulfillmentFeeSource:
      result.fulfillmentSource === 'sp-api' || result.fulfillmentSource === 'rate-table'
        ? result.fulfillmentSource
        : null,
  })
}
