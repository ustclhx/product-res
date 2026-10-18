import type { CostingInput, CostParams, LogisticsProfile, SupplierQuote } from '../src/index.ts'

export const quote: SupplierQuote = {
  id: 'q1',
  currency: 'CNY',
  tiers: [
    { minQty: 100, unitPriceMinor: 1200 },
    { minQty: 500, unitPriceMinor: 1000 },
  ],
  moq: 100,
  weightG: 800,
  dimensions: { lengthCm: 30, widthCm: 20, heightCm: 10 },
  confidence: 'confirmed',
  procurementDays: 10,
}

/** eBay 直发：首重 500g ¥30，续重每 100g ¥5，体积重系数 6000 */
export const ebayDirect: LogisticsProfile = {
  id: 'ebay-direct',
  platform: 'ebay',
  type: 'ebay-direct',
  transitDays: 12,
  lastMile: {
    kind: 'first-additional',
    currency: 'CNY',
    firstWeightG: 500,
    firstPriceMinor: 3000,
    stepWeightG: 100,
    stepPriceMinor: 500,
    volumetricDivisor: 6000,
  },
}

/** FBA 海运按方 ¥1200/m³，35 天 */
export const fbaSea: LogisticsProfile = {
  id: 'fba-sea',
  platform: 'amazon',
  type: 'amazon-fba',
  transitDays: 35,
  headFreight: { kind: 'volume', currency: 'CNY', pricePerCbmMinor: 120000 },
}

/** FBA 空运首重续重每 kg ¥40，8 天 */
export const fbaAir: LogisticsProfile = {
  id: 'fba-air',
  platform: 'amazon',
  type: 'amazon-fba',
  transitDays: 8,
  headFreight: {
    kind: 'first-additional',
    currency: 'CNY',
    firstWeightG: 1000,
    firstPriceMinor: 4000,
    stepWeightG: 1000,
    stepPriceMinor: 4000,
    volumetricDivisor: 6000,
  },
}

export const ebayParams: CostParams = {
  commissionRate: 0.15,
  fixedFeeMinor: 30,
  adRate: 0.05,
  returnRate: 0.03,
}

export const amazonParams: CostParams = {
  ...ebayParams,
  fixedFeeMinor: 0,
  storageMonthlyMinor: 20,
  storageMonths: 2,
  inboundFeeMinor: 30,
}

export const fx = [{ from: 'USD', to: 'CNY', rate: 7.2 }]

export const directInput: CostingInput = {
  plannedQty: 300,
  salePrice: { amountMinor: 2999, currency: 'USD' },
  quote,
  profile: ebayDirect,
  mode: 'same-source',
  costParams: ebayParams,
  fxRates: fx,
}
