import { describe, expect, it } from 'vitest'
import type { MatrixInput } from '../src/index.ts'
import { buildCostingMatrix } from '../src/index.ts'
import { amazonParams, ebayDirect, ebayParams, fbaAir, fbaSea, fx, quote } from './fixtures.ts'

const schedule = {
  saleStartDate: '2026-12-01',
  today: '2026-10-19',
  listingPrepDays: 3,
  inboundDays: 10,
}
const base: MatrixInput = {
  plannedQty: 300,
  salePrice: { amountMinor: 2999, currency: 'USD' },
  quotes: [quote],
  profiles: [fbaSea, fbaAir],
  modes: ['same-source'],
  costParams: { amazon: amazonParams, ebay: ebayParams },
  fulfillmentFee: { amountMinor: 450, currency: 'USD', source: 'sp-api' },
  fxRates: fx,
  // 海运 35 + 入库 10 + 采购 10 + 上架 3 = 58 天 → 10/04 来不及；空运 8 天 → 10/31
  schedule,
}
const cell = (m: ReturnType<typeof buildCostingMatrix>, profileId: string, quoteId = 'q1') =>
  m.cells.find((c) => c.profileId === profileId && c.quoteId === quoteId)

describe('buildCostingMatrix', () => {
  it('来不及的组合标为 too-late，不作为最优；最优取来得及的空运', () => {
    const m = buildCostingMatrix(base)
    const sea = cell(m, 'fba-sea')
    expect(sea).toMatchObject({ deadline: '2026-10-04', available: false, reasons: ['too-late'] })
    // 海运更便宜、毛利率更高，但来不及
    expect(sea?.result?.grossMargin).toBeGreaterThan(cell(m, 'fba-air')?.result?.grossMargin ?? 1)
    expect(cell(m, 'fba-air')).toMatchObject({ deadline: '2026-10-31', available: true })
    expect(m.best?.profileId).toBe('fba-air')
  })

  it('低于 MOQ 的报价显示 below-moq，不参与最优', () => {
    const m = buildCostingMatrix({
      ...base,
      schedule: null,
      quotes: [
        { ...quote, id: 'cheap', moq: 500, tiers: [{ minQty: 500, unitPriceMinor: 500 }] },
        quote,
      ],
    })
    expect(cell(m, 'fba-sea', 'cheap')?.reasons).toEqual(['below-moq'])
    expect(m.best?.quoteId).toBe('q1')
    expect(m.best?.profileId).toBe('fba-sea')
  })

  it('禁运属性冲突的方案不可用', () => {
    const m = buildCostingMatrix({
      ...base,
      schedule: null,
      profiles: [{ ...fbaSea, bannedAttributes: ['Battery'] }, fbaAir],
      productAttributes: ['battery'],
    })
    expect(cell(m, 'fba-sea')).toMatchObject({
      reasons: ['shipping-ban'],
      bannedAttributes: ['battery'],
    })
    expect(m.best?.profileId).toBe('fba-air')
  })

  it('缺少重量：依赖重量的物流组合显示缺少重量，不给毛利率；按方组合不受影响', () => {
    const m = buildCostingMatrix({ ...base, schedule: null, quotes: [{ ...quote, weightG: null }] })
    expect(cell(m, 'fba-air')).toMatchObject({
      reasons: ['missing-input'],
      missing: ['weight'],
      result: null,
      certainty: null,
    })
    expect(cell(m, 'fba-sea')?.result).not.toBeNull()
    expect(m.best?.profileId).toBe('fba-sea')
  })

  it('全部不可用时没有最优组合', () => {
    const m = buildCostingMatrix({ ...base, salePrice: null })
    expect(m.cells.every((c) => c.reasons.includes('missing-input'))).toBe(true)
    expect(m.best).toBeNull()
  })

  it('报价 × 物流 × 方式全组合，并给出成本确定性', () => {
    const m = buildCostingMatrix({
      ...base,
      schedule: null,
      quotes: [quote, { ...quote, id: 'q2', confidence: 'public', dimensions: null }],
      profiles: [fbaAir, ebayDirect],
      modes: ['same-source', 'improved'],
      improvement: {
        unitSurchargeRate: 0.1,
        toolingCost: { amountMinor: 0, currency: 'CNY' },
        sampleDays: 7,
      },
    })
    expect(m.cells).toHaveLength(8)
    expect(cell(m, 'fba-air')?.certainty).toBe(1)
    expect(cell(m, 'ebay-direct')?.certainty).toBe(1)
    // 公开价 0.6、缺尺寸 0.5、SP-API 1.0
    expect(cell(m, 'fba-air', 'q2')?.certainty).toBeCloseTo(0.7)
    expect(cell(m, 'ebay-direct', 'q2')?.certainty).toBeCloseTo(0.55)
  })

  it('缺采购时长等日程输入时报告缺失', () => {
    const m = buildCostingMatrix({ ...base, quotes: [{ ...quote, procurementDays: null }] })
    expect(cell(m, 'fba-air')).toMatchObject({
      reasons: ['missing-input'],
      missing: ['procurementDays'],
      deadline: null,
    })
    const withDefault = buildCostingMatrix({
      ...base,
      quotes: [{ ...quote, procurementDays: null }],
      schedule: { ...schedule, defaultProcurementDays: 10 },
    })
    expect(cell(withDefault, 'fba-air')?.deadline).toBe('2026-10-31')
  })
})
