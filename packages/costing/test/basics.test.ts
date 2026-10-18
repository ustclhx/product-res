import { describe, expect, it } from 'vitest'
import {
  chargeableWeightG,
  convertMoney,
  costCertainty,
  effectiveMoq,
  firstAdditionalCost,
  isBelowMoq,
  isTooLate,
  latestDecisionDate,
  medianMinor,
  resolveCostParams,
  shippingCost,
  tierUnitPrice,
} from '../src/index.ts'
import { ebayDirect, quote } from './fixtures.ts'

describe('报价阶梯与 MOQ', () => {
  const tiers = [
    { minQty: 500, unitPriceMinor: 1000 },
    { minQty: 100, unitPriceMinor: 1200 },
  ]

  it('阶梯价：100 件 ¥12、500 件 ¥10，计划 300 件取 ¥12', () => {
    expect(tierUnitPrice(tiers, 300)).toBe(1200)
    expect(tierUnitPrice(tiers, 500)).toBe(1000)
    expect(tierUnitPrice(tiers, 50)).toBe(1200)
    expect(tierUnitPrice([], 300)).toBeNull()
  })

  it('低于 MOQ：MOQ 500、计划 300 不可用；未设 MOQ 时取最低阶梯', () => {
    expect(isBelowMoq({ ...quote, moq: 500 }, 300)).toBe(true)
    expect(isBelowMoq({ ...quote, moq: 500 }, 500)).toBe(false)
    expect(effectiveMoq({ ...quote, moq: null })).toBe(100)
    expect(isBelowMoq({ ...quote, moq: null }, 99)).toBe(true)
    expect(isBelowMoq({ ...quote, moq: null, tiers: [] }, 1)).toBe(false)
  })
})

describe('计费重量', () => {
  it('体积重：30×20×10 cm、实重 0.8 kg、系数 6000 → 1.0 kg', () => {
    expect(chargeableWeightG(800, { lengthCm: 30, widthCm: 20, heightCm: 10 }, 6000)).toBe(1000)
  })

  it('实重大于体积重时取实重；无尺寸或无系数时按实重', () => {
    expect(chargeableWeightG(1500, { lengthCm: 30, widthCm: 20, heightCm: 10 }, 6000)).toBe(1500)
    expect(chargeableWeightG(800, null, 6000)).toBe(800)
    expect(chargeableWeightG(800, { lengthCm: 30, widthCm: 20, heightCm: 10 })).toBe(800)
  })

  it('首重续重：不足一个续重单位按一个计', () => {
    const f = ebayDirect.lastMile
    if (f?.kind !== 'first-additional') throw new Error('fixture')
    expect(firstAdditionalCost(400, f)).toBe(3000)
    expect(firstAdditionalCost(500, f)).toBe(3000)
    expect(firstAdditionalCost(501, f)).toBe(3500)
    expect(firstAdditionalCost(1000, f)).toBe(5500)
  })

  it('按方计费：缺尺寸报告 dimensions，最低方数生效', () => {
    const f = { kind: 'volume' as const, currency: 'CNY', pricePerCbmMinor: 100000, minCbm: 1 }
    expect(shippingCost(f, { weightG: 800, qty: 10 })).toEqual({
      status: 'missing',
      missing: ['dimensions'],
    })
    const r = shippingCost(f, { dimensions: { lengthCm: 30, widthCm: 20, heightCm: 10 }, qty: 10 })
    expect(r).toMatchObject({ status: 'ok', totalMinor: 100000, chargeableWeightG: null })
  })

  it('首重续重缺重量报告 weight；缺尺寸时按实重并标记', () => {
    const f = ebayDirect.lastMile
    if (!f) throw new Error('fixture')
    expect(shippingCost(f, { qty: 1 })).toEqual({ status: 'missing', missing: ['weight'] })
    expect(shippingCost(f, { weightG: 800, qty: 1 })).toMatchObject({
      status: 'ok',
      chargeableWeightG: 800,
      dimensionsMissing: true,
    })
  })
})

describe('汇率与中位价', () => {
  it('支持反向汇率，缺汇率返回 null，零位小数币种按位数换算', () => {
    const rates = [{ from: 'USD', to: 'CNY', rate: 7.2 }]
    expect(convertMoney({ amountMinor: 720, currency: 'CNY' }, 'USD', rates)).toEqual({
      amountMinor: 100,
      currency: 'USD',
    })
    expect(convertMoney({ amountMinor: 100, currency: 'EUR' }, 'USD', rates)).toBeNull()
    expect(
      convertMoney({ amountMinor: 100, currency: 'USD' }, 'JPY', [
        { from: 'USD', to: 'JPY', rate: 150 },
      ]),
    ).toEqual({ amountMinor: 150, currency: 'JPY' })
  })

  it('竞品中位价', () => {
    expect(medianMinor([1500, 999, 2000])).toBe(1500)
    expect(medianMinor([1000, 2001])).toBe(1501)
    expect(medianMinor([])).toBeNull()
  })
})

describe('最晚决定日', () => {
  it('返校季 7/15、海运 35 + FBA 入库 10、采购 10、上架 3 → 5/18', () => {
    const r = latestDecisionDate({
      saleStartDate: '2026-07-15',
      logisticsType: 'amazon-fba',
      transitDays: 35,
      inboundDays: 10,
      procurementDays: 10,
      mode: 'same-source',
      listingPrepDays: 3,
    })
    expect(r).toEqual({ status: 'ok', date: '2026-05-18' })
  })

  it('微改良加打样天数；非 FBA 不加入库', () => {
    const r = latestDecisionDate({
      saleStartDate: '2026-07-15',
      logisticsType: 'ebay-direct',
      transitDays: 12,
      inboundDays: 10,
      procurementDays: 10,
      mode: 'improved',
      sampleDays: 7,
      listingPrepDays: 3,
    })
    expect(r).toEqual({ status: 'ok', date: '2026-06-13' })
  })

  it('缺采购时长、打样天数、入库时长时报告缺失', () => {
    const r = latestDecisionDate({
      saleStartDate: '2026-07-15',
      logisticsType: 'amazon-fba',
      transitDays: 35,
      mode: 'improved',
      listingPrepDays: 3,
    })
    expect(r).toEqual({
      status: 'missing',
      missing: ['procurementDays', 'inboundDays', 'sampleDays'],
    })
  })

  it('早于今天才算来不及；非法日期抛错', () => {
    expect(isTooLate('2026-10-18', '2026-10-19')).toBe(true)
    expect(isTooLate('2026-10-19', '2026-10-19')).toBe(false)
    expect(() => isTooLate('2026/10/19', '2026-10-19')).toThrow()
  })
})

describe('成本确定性', () => {
  it('三项平均；非 FBA 只平均前两项', () => {
    expect(
      costCertainty({
        quoteConfidence: 'confirmed',
        logisticsComplete: true,
        fulfillmentFeeSource: 'sp-api',
      }),
    ).toBe(1)
    expect(
      costCertainty({
        quoteConfidence: 'public',
        logisticsComplete: false,
        fulfillmentFeeSource: 'rate-table',
      }),
    ).toBeCloseTo((0.6 + 0.5 + 0.7) / 3)
    expect(
      costCertainty({
        quoteConfidence: 'public',
        logisticsComplete: true,
        fulfillmentFeeSource: null,
      }),
    ).toBeCloseTo(0.8)
  })
})

describe('类目回退', () => {
  it('类目未配置佣金率时用平台默认并标注来源；显式 0 不回退', () => {
    const { params, sources } = resolveCostParams(
      { commissionRate: 0.15, fixedFeeMinor: 30, adRate: 0.05 },
      { commissionRate: null, adRate: 0 },
    )
    expect(params).toEqual({ commissionRate: 0.15, fixedFeeMinor: 30, adRate: 0 })
    expect(sources.commissionRate).toBe('platform-default')
    expect(sources.adRate).toBe('category')
    expect(sources.returnRate).toBe('missing')
  })
})
