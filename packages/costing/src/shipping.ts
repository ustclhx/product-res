import type { Dimensions, Missing, ShippingFormula } from './types.ts'

const CM3_PER_CBM = 1_000_000

/** 体积重（克）= 长 × 宽 × 高(cm) ÷ 系数 × 1000 */
export function volumetricWeightG(dimensions: Dimensions, divisor: number): number {
  return ((dimensions.lengthCm * dimensions.widthCm * dimensions.heightCm) / divisor) * 1000
}

/** 计费重量（克）：取实重与体积重较大者；未给尺寸或系数时为实重 */
export function chargeableWeightG(
  weightG: number,
  dimensions?: Dimensions | null,
  divisor?: number,
): number {
  if (!dimensions || !divisor) return weightG
  return Math.max(weightG, volumetricWeightG(dimensions, divisor))
}

/** 首重续重：不足一个续重单位按一个计 */
export function firstAdditionalCost(
  weightG: number,
  f: Extract<ShippingFormula, { kind: 'first-additional' }>,
): number {
  if (weightG <= f.firstWeightG) return f.firstPriceMinor
  // 浮点体积重可能带极小尾差（如 1000.0000001），先收敛到 0.001 克再向上取整
  const extra = Math.round((weightG - f.firstWeightG) * 1000) / 1000
  return f.firstPriceMinor + Math.ceil(extra / f.stepWeightG) * f.stepPriceMinor
}

export type ShippingQuote = {
  status: 'ok'
  /** 整批运费（公式币种最小单位，未取整） */
  totalMinor: number
  /** 单件计费重量（克）；按方计费时为 null */
  chargeableWeightG: number | null
  /** 公式需要尺寸（体积重）但缺少尺寸，已退化为按实重计费 */
  dimensionsMissing: boolean
}

/**
 * 按公式计算 qty 件的运费。首重续重必需重量，尺寸缺失时按实重计费并标记；按方计费必需尺寸。
 */
export function shippingCost(
  formula: ShippingFormula,
  item: { weightG?: number | null; dimensions?: Dimensions | null; qty: number },
): ShippingQuote | Missing {
  if (formula.kind === 'volume') {
    if (!item.dimensions) return { status: 'missing', missing: ['dimensions'] }
    const d = item.dimensions
    const cbm = Math.max(
      ((d.lengthCm * d.widthCm * d.heightCm) / CM3_PER_CBM) * item.qty,
      formula.minCbm ?? 0,
    )
    return {
      status: 'ok',
      totalMinor: cbm * formula.pricePerCbmMinor,
      chargeableWeightG: null,
      dimensionsMissing: false,
    }
  }
  if (item.weightG == null) return { status: 'missing', missing: ['weight'] }
  const unitWeight = chargeableWeightG(item.weightG, item.dimensions, formula.volumetricDivisor)
  return {
    status: 'ok',
    totalMinor: firstAdditionalCost(unitWeight * item.qty, formula),
    chargeableWeightG: unitWeight,
    dimensionsMissing: Boolean(formula.volumetricDivisor) && !item.dimensions,
  }
}
