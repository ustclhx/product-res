import type { Money, PriceTier, SupplierQuote } from './types.ts'

/**
 * 按计划数量取阶梯单价：取 minQty ≤ 计划数量 的最高一档。
 * 计划数量低于最低一档时取最低一档的价格（偏保守，是否可下单由 MOQ 判定）；无阶梯返回 null。
 */
export function tierUnitPrice(tiers: PriceTier[], plannedQty: number): number | null {
  if (tiers.length === 0) return null
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty)
  let chosen = sorted[0] as PriceTier
  for (const tier of sorted) {
    if (tier.minQty <= plannedQty) chosen = tier
  }
  return chosen.unitPriceMinor
}

export function quoteUnitPrice(quote: SupplierQuote, plannedQty: number): Money | null {
  const amount = tierUnitPrice(quote.tiers, plannedQty)
  return amount === null ? null : { amountMinor: amount, currency: quote.currency }
}

/** 有效 MOQ：显式 MOQ 优先，否则为最低阶梯数量 */
export function effectiveMoq(quote: SupplierQuote): number {
  if (quote.moq != null) return quote.moq
  if (quote.tiers.length === 0) return 0
  return Math.min(...quote.tiers.map((t) => t.minQty))
}

/** 计划数量低于 MOQ 时报价不可用 */
export function isBelowMoq(quote: SupplierQuote, plannedQty: number): boolean {
  return plannedQty < effectiveMoq(quote)
}
