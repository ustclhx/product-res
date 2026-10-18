import { describe, expect, it } from 'vitest'
import { latestDecisionDate, nextOccurrence, slackDays } from '../src/index.ts'

describe('最晚决定日（specs/selection-directions）', () => {
  it('返校季 7/15 起卖，物流 35 + FBA 入库 10 + 采购 10 + 上架 3 → 5/18', () => {
    const result = latestDecisionDate({
      salesStart: '2026-07-15',
      platform: 'amazon',
      logisticsDays: 35,
      fbaInboundDays: 10,
      procurementDays: 10,
      listingPrepDays: 3,
    })
    expect(result.deadline).toBe('2026-05-18')
    expect(result.totalLeadDays).toBe(58)
  })

  it('eBay 不计 FBA 入库；非微改良不计打样', () => {
    const result = latestDecisionDate({
      salesStart: '2026-07-15',
      platform: 'ebay',
      logisticsDays: 35,
      fbaInboundDays: 10,
      procurementDays: 10,
      samplingDays: 7,
      listingPrepDays: 3,
    })
    expect(result.deadline).toBe('2026-05-28')
    expect(result.parts.fbaInboundDays).toBe(0)
    expect(result.parts.samplingDays).toBe(0)
  })

  it('微改良再加打样天数', () => {
    const result = latestDecisionDate({
      salesStart: '2026-07-15',
      platform: 'amazon',
      improved: true,
      logisticsDays: 35,
      fbaInboundDays: 10,
      procurementDays: 10,
      samplingDays: 7,
      listingPrepDays: 3,
    })
    expect(result.deadline).toBe('2026-05-11')
  })

  it('负数提前期报错', () => {
    expect(() =>
      latestDecisionDate({
        salesStart: '2026-07-15',
        platform: 'ebay',
        logisticsDays: -1,
        procurementDays: 0,
        listingPrepDays: 0,
      }),
    ).toThrow(RangeError)
  })

  it('下一次节点日期与余量', () => {
    expect(nextOccurrence(7, 15, '2026-05-01')).toBe('2026-07-15')
    expect(nextOccurrence(7, 15, '2026-07-15')).toBe('2026-07-15')
    expect(nextOccurrence(7, 15, '2026-10-19')).toBe('2027-07-15')
    expect(slackDays('2026-05-18', '2026-05-10')).toBe(8)
    expect(slackDays('2026-05-18', '2026-05-20')).toBe(-2)
  })
})
