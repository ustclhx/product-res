import { assertPositiveInt, convertMinorExact } from './money.ts'
import { quoteUnitPrice } from './quote.ts'
import { shippingCost } from './shipping.ts'
import type {
  CostBreakdown,
  CostingInput,
  CostingOutcome,
  LogisticsType,
  Missing,
  MissingInput,
  WaterfallStep,
} from './types.ts'

// 浮点误差容差：避免 830 / 0.77 这类除法在整数边界被多进一分
const EPSILON = 1e-9

/** 头程到仓再由仓库发货的方案需要头程与仓储 */
export function usesWarehouse(type: LogisticsType): boolean {
  return type === 'ebay-overseas' || type === 'amazon-fba'
}

/**
 * 保本价：解 净利润 = 0。平台佣金、广告、退货预留随售价线性变化，
 * 售价 = (落地成本 + 固定费) ÷ (1 − 佣金率 − 广告率 − 退货率)，向上取整到最小单位以保证不亏。
 * 费率和 ≥ 1 时无解，返回 null。
 */
export function breakEvenPriceMinor(input: {
  landedCostMinor: number
  fixedFeeMinor: number
  commissionRate: number
  adRate: number
  returnRate: number
}): number | null {
  const denominator = 1 - input.commissionRate - input.adRate - input.returnRate
  if (denominator <= EPSILON) return null
  return Math.ceil((input.landedCostMinor + input.fixedFeeMinor) / denominator - EPSILON)
}

/** 成本瀑布：仓储与入库费并入配送/尾程，改款费分摊并入采购，各步之和等于售价 */
export function costWaterfall(costs: CostBreakdown, netProfitMinor: number): WaterfallStep[] {
  return [
    { key: 'purchase', amountMinor: costs.purchaseMinor + costs.modificationMinor },
    { key: 'headFreight', amountMinor: costs.headFreightMinor },
    { key: 'platformFee', amountMinor: costs.platformFeeMinor },
    { key: 'fulfillment', amountMinor: costs.fulfillmentMinor + costs.storageMinor },
    { key: 'ads', amountMinor: costs.adsMinor },
    { key: 'returns', amountMinor: costs.returnsMinor },
    { key: 'netProfit', amountMinor: netProfitMinor },
  ]
}

/**
 * 计算一个 报价 × 物流方案 × 跟卖方式 组合的单件成本与利润。
 * 任一必需输入缺失时返回 { status: 'missing', missing }，不以 0 代替。
 * MOQ、禁运与时效判定在矩阵层处理，这里只算账。
 */
export function computeCosting(input: CostingInput): CostingOutcome {
  assertPositiveInt('plannedQty', input.plannedQty)
  const { quote, profile, costParams: p, plannedQty: qty } = input
  const missing = new Set<MissingInput>()
  const target = input.salePrice?.currency ?? null
  // 换算到售价币种；缺售价时无从换算，只记录其他缺失
  const toTarget = (amountMinor: number, currency: string): number | null => {
    if (target === null) return null
    const v = convertMinorExact(amountMinor, currency, target, input.fxRates)
    if (v === null) missing.add('fxRate')
    return v
  }

  if (!input.salePrice) missing.add('salePrice')
  if (p.commissionRate == null) missing.add('commissionRate')
  if (p.fixedFeeMinor == null) missing.add('fixedFee')
  if (p.adRate == null) missing.add('adRate')
  if (p.returnRate == null) missing.add('returnRate')

  // 采购与改款费分摊
  const unitPrice = quoteUnitPrice(quote, qty)
  if (!unitPrice) missing.add('unitPrice')
  const improvement = input.mode === 'improved' ? input.improvement : null
  if (input.mode === 'improved' && !improvement) missing.add('improvement')
  const purchase = unitPrice
    ? toTarget(
        unitPrice.amountMinor * (1 + (improvement?.unitSurchargeRate ?? 0)),
        unitPrice.currency,
      )
    : null
  const modification = improvement
    ? toTarget(improvement.toolingCost.amountMinor / qty, improvement.toolingCost.currency)
    : 0

  const item = { weightG: quote.weightG ?? null, dimensions: quote.dimensions ?? null }
  let chargeableWeightG: number | null = null
  let dimensionsMissing = false
  const collect = (m: Missing) => {
    for (const x of m.missing) missing.add(x)
  }

  // 头程：整批计费后按数量分摊
  let headFreight: number | null = 0
  if (usesWarehouse(profile.type)) {
    headFreight = null
    if (!profile.headFreight) missing.add('headFreight')
    else {
      const s = shippingCost(profile.headFreight, { ...item, qty })
      if (s.status === 'missing') collect(s)
      else {
        chargeableWeightG = s.chargeableWeightG
        dimensionsMissing ||= s.dimensionsMissing
        headFreight = toTarget(s.totalMinor / qty, profile.headFreight.currency)
      }
    }
  }

  // 配送/尾程：FBA 用配送费预估，其余按单件运费公式
  let fulfillment: number | null = null
  let fulfillmentSource: 'sp-api' | 'rate-table' | 'profile' | null = null
  if (profile.type === 'amazon-fba') {
    const fee = input.fulfillmentFee
    if (!fee) missing.add('fulfillmentFee')
    else {
      fulfillment = toTarget(fee.amountMinor, fee.currency)
      fulfillmentSource = fee.source
    }
  } else if (!profile.lastMile) missing.add('lastMile')
  else {
    const s = shippingCost(profile.lastMile, { ...item, qty: 1 })
    if (s.status === 'missing') collect(s)
    else {
      chargeableWeightG ??= s.chargeableWeightG
      dimensionsMissing ||= s.dimensionsMissing
      fulfillment = toTarget(s.totalMinor, profile.lastMile.currency)
      fulfillmentSource = 'profile'
    }
  }

  // 仓储：月仓储费 × 库存月数，FBA 另加入库配置费
  let storage = 0
  if (usesWarehouse(profile.type)) {
    if (p.storageMonthlyMinor == null || p.storageMonths == null) missing.add('storageFee')
    else storage = p.storageMonthlyMinor * p.storageMonths
    if (profile.type === 'amazon-fba') {
      if (p.inboundFeeMinor == null) missing.add('inboundFee')
      else storage += p.inboundFeeMinor
    }
  }

  if (missing.size > 0) return { status: 'missing', missing: [...missing] }
  // 以下字段在上方已逐一校验非空
  const price = input.salePrice?.amountMinor as number
  const rates = {
    commissionRate: p.commissionRate as number,
    adRate: p.adRate as number,
    returnRate: p.returnRate as number,
  }
  const fixedFeeMinor = p.fixedFeeMinor as number

  const costs: CostBreakdown = {
    purchaseMinor: Math.round(purchase as number),
    headFreightMinor: Math.round(headFreight as number),
    platformFeeMinor: Math.round(price * rates.commissionRate + fixedFeeMinor),
    fulfillmentMinor: Math.round(fulfillment as number),
    storageMinor: Math.round(storage),
    adsMinor: Math.round(price * rates.adRate),
    returnsMinor: Math.round(price * rates.returnRate),
    modificationMinor: Math.round(modification as number),
  }
  const landedCostMinor =
    costs.purchaseMinor +
    costs.headFreightMinor +
    costs.fulfillmentMinor +
    costs.storageMinor +
    costs.modificationMinor
  const netProfitMinor =
    price - landedCostMinor - costs.platformFeeMinor - costs.adsMinor - costs.returnsMinor

  return {
    status: 'ok',
    currency: target as string,
    salePriceMinor: price,
    unitPrice: unitPrice as NonNullable<typeof unitPrice>,
    chargeableWeightG,
    dimensionsMissing,
    costs,
    landedCostMinor,
    netProfitMinor,
    grossMargin: price > 0 ? netProfitMinor / price : 0,
    breakEvenMinor: breakEvenPriceMinor({ landedCostMinor, fixedFeeMinor, ...rates }),
    fulfillmentSource,
    waterfall: costWaterfall(costs, netProfitMinor),
  }
}
