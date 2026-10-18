import { describe, expect, it } from 'vitest'
import { breakEvenPriceMinor, computeCosting } from '../src/index.ts'
import { amazonParams, directInput, fbaSea, fx, quote } from './fixtures.ts'

describe('保本价', () => {
  it('佣金 15%、广告 5%、退货 3%、固定费 $0.30、落地成本 $8.00 → $10.78', () => {
    expect(
      breakEvenPriceMinor({
        landedCostMinor: 800,
        fixedFeeMinor: 30,
        commissionRate: 0.15,
        adRate: 0.05,
        returnRate: 0.03,
      }),
    ).toBe(1078)
  })

  it('整除时不因浮点多进一分；费率和 ≥ 1 无解', () => {
    expect(
      breakEvenPriceMinor({
        landedCostMinor: 70,
        fixedFeeMinor: 0,
        commissionRate: 0.1,
        adRate: 0.1,
        returnRate: 0.1,
      }),
    ).toBe(100)
    expect(
      breakEvenPriceMinor({
        landedCostMinor: 800,
        fixedFeeMinor: 30,
        commissionRate: 0.6,
        adRate: 0.3,
        returnRate: 0.1,
      }),
    ).toBeNull()
  })
})

describe('computeCosting', () => {
  it('eBay 直发：各成本项、净利润、毛利率、保本价与瀑布', () => {
    const r = computeCosting(directInput)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    // ¥12 ÷ 7.2 = $1.67；运费 1.0kg = ¥30 + 5 × ¥5 = ¥55 ÷ 7.2 = $7.64
    expect(r.costs).toEqual({
      purchaseMinor: 167,
      headFreightMinor: 0,
      platformFeeMinor: 480,
      fulfillmentMinor: 764,
      storageMinor: 0,
      adsMinor: 150,
      returnsMinor: 90,
      modificationMinor: 0,
    })
    expect(r.chargeableWeightG).toBe(1000)
    expect(r.landedCostMinor).toBe(931)
    expect(r.netProfitMinor).toBe(1348)
    expect(r.grossMargin).toBeCloseTo(1348 / 2999)
    expect(r.breakEvenMinor).toBe(1249)
    expect(r.fulfillmentSource).toBe('profile')
    expect(r.waterfall.map((s) => s.key)).toEqual([
      'purchase',
      'headFreight',
      'platformFee',
      'fulfillment',
      'ads',
      'returns',
      'netProfit',
    ])
    expect(r.waterfall.reduce((sum, s) => sum + s.amountMinor, 0)).toBe(2999)
  })

  it('保本价处净利润约为 0', () => {
    const r = computeCosting(directInput)
    if (r.status !== 'ok' || r.breakEvenMinor === null) throw new Error('unexpected')
    const at = computeCosting({
      ...directInput,
      salePrice: { amountMinor: r.breakEvenMinor, currency: 'USD' },
    })
    if (at.status !== 'ok') throw new Error('unexpected')
    expect(Math.abs(at.netProfitMinor)).toBeLessThanOrEqual(2)
  })

  it('缺少重量：返回 missing weight，不给毛利率', () => {
    const r = computeCosting({ ...directInput, quote: { ...quote, weightG: null } })
    expect(r).toEqual({ status: 'missing', missing: ['weight'] })
  })

  it('多项缺失一并报告，不用 0 代替；显式 0 视为已录入', () => {
    const r = computeCosting({
      ...directInput,
      salePrice: null,
      quote: { ...quote, tiers: [] },
      costParams: { fixedFeeMinor: 0 },
    })
    expect(r.status).toBe('missing')
    if (r.status === 'missing') {
      expect(r.missing.sort()).toEqual(
        ['adRate', 'commissionRate', 'returnRate', 'salePrice', 'unitPrice'].sort(),
      )
    }
  })

  it('缺汇率时报告 fxRate', () => {
    expect(computeCosting({ ...directInput, fxRates: [] })).toEqual({
      status: 'missing',
      missing: ['fxRate'],
    })
  })

  it('FBA：头程按方分摊、配送费来源、仓储与入库费', () => {
    const r = computeCosting({
      ...directInput,
      profile: fbaSea,
      costParams: amazonParams,
      fulfillmentFee: { amountMinor: 450, currency: 'USD', source: 'rate-table' },
    })
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    // 300 件 × 0.006 m³ = 1.8 m³ × ¥1200 = ¥2160 ÷ 300 = ¥7.2 = $1.00
    expect(r.costs.headFreightMinor).toBe(100)
    expect(r.costs.fulfillmentMinor).toBe(450)
    expect(r.costs.storageMinor).toBe(20 * 2 + 30)
    expect(r.fulfillmentSource).toBe('rate-table')
    expect(r.landedCostMinor).toBe(167 + 100 + 450 + 70)
  })

  it('FBA 缺配送费、仓储与入库费时报告缺失', () => {
    const r = computeCosting({
      ...directInput,
      profile: fbaSea,
      costParams: { ...directInput.costParams },
    })
    expect(r.status).toBe('missing')
    if (r.status === 'missing') {
      expect(r.missing.sort()).toEqual(['fulfillmentFee', 'inboundFee', 'storageFee'])
    }
  })

  it('微改良：单价加成与改款费分摊；缺改良参数时报告缺失', () => {
    const r = computeCosting({
      ...directInput,
      mode: 'improved',
      improvement: {
        unitSurchargeRate: 0.2,
        toolingCost: { amountMinor: 216000, currency: 'CNY' },
        sampleDays: 7,
      },
    })
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    // ¥12 × 1.2 = ¥14.4 = $2.00；¥2160 ÷ 300 = ¥7.2 = $1.00
    expect(r.costs.purchaseMinor).toBe(200)
    expect(r.costs.modificationMinor).toBe(100)
    expect(r.waterfall[0]).toEqual({ key: 'purchase', amountMinor: 300 })
    expect(computeCosting({ ...directInput, mode: 'improved' })).toEqual({
      status: 'missing',
      missing: ['improvement'],
    })
  })

  it('计划数量非正整数时抛错', () => {
    expect(() => computeCosting({ ...directInput, plannedQty: 0 })).toThrow()
  })

  it('不修改共享汇率', () => {
    computeCosting(directInput)
    expect(fx).toEqual([{ from: 'USD', to: 'CNY', rate: 7.2 }])
  })
})
