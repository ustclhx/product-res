import { describe, expect, it } from 'vitest'
import { deadlineTone, nextNodeStart, reviewDueOn, todaySgt, weekStartSgt } from './dates.ts'
import { parseMoney, parsePercent } from './format.ts'
import { summarizeScenario } from './scenario.ts'

// tasks 3.2 / 4.1：队列橙 / 红标记、节点倒计时、回看到期日与组合快照读取。
describe('待决定队列标记', () => {
  const today = '2026-10-19'
  it('最晚决定日在 5 天后标橙，含当天与第 7 天', () => {
    expect(deadlineTone('2026-10-24', today)).toBe('soon')
    expect(deadlineTone('2026-10-19', today)).toBe('soon')
    expect(deadlineTone('2026-10-26', today)).toBe('soon')
  })
  it('已过最晚决定日标红；7 天以外不标；没有日期为 none', () => {
    expect(deadlineTone('2026-10-18', today)).toBe('overdue')
    expect(deadlineTone('2026-10-27', today)).toBe('normal')
    expect(deadlineTone(null, today)).toBe('none')
  })
})

describe('新加坡时间', () => {
  it('UTC 16:00 之后已是新加坡的次日；本周从周一 00:00 SGT 起算', () => {
    expect(todaySgt(new Date('2026-10-19T15:59:00Z'))).toBe('2026-10-19')
    expect(todaySgt(new Date('2026-10-19T16:00:00Z'))).toBe('2026-10-20')
    // 2026-10-19 是周一
    expect(weekStartSgt(new Date('2026-10-22T03:00:00Z')).toISOString()).toBe(
      '2026-10-18T16:00:00.000Z',
    )
  })
})

describe('节点倒计时', () => {
  const blackFriday = { startMonth: 11, startDay: 27, salesDays: 7 }
  it('未到起卖日时给出剩余天数，销售期内显示销售中，过后滚到下一年', () => {
    expect(nextNodeStart(blackFriday, '2026-10-19')).toEqual({
      start: '2026-11-27',
      daysLeft: 39,
      selling: false,
    })
    expect(nextNodeStart(blackFriday, '2026-11-29')).toMatchObject({
      start: '2026-11-27',
      selling: true,
    })
    expect(nextNodeStart(blackFriday, '2026-12-10')).toMatchObject({
      start: '2027-11-27',
      selling: false,
    })
  })
  it('跨年销售期与平年的 2/29', () => {
    const newYear = { startMonth: 12, startDay: 26, salesDays: 14 }
    expect(nextNodeStart(newYear, '2027-01-03')).toMatchObject({
      start: '2026-12-26',
      selling: true,
    })
    expect(
      nextNodeStart({ startMonth: 2, startDay: 29, salesDays: 1 }, '2027-01-01'),
    ).toMatchObject({ start: '2027-02-28' })
  })
})

describe('回看与金额输入', () => {
  it('回看到期日为计划上架日 + 30 天', () => {
    expect(reviewDueOn('2026-09-01')).toBe('2026-10-01')
  })
  it('主单位金额与百分比换算', () => {
    expect(parseMoney('10.78')).toBe(1078)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('1.234')).toBeNaN()
    expect(parsePercent('15')).toBe(0.15)
    expect(parsePercent('101')).toBeNaN()
  })
})

describe('核算组合快照', () => {
  const ok = {
    status: 'ok',
    currency: 'USD',
    salePriceMinor: 1999,
    landedCostMinor: 820,
    netProfitMinor: 450,
    grossMargin: 0.225,
    breakEvenMinor: 1078,
  }
  it('读取 CostingResult 与整格矩阵结果两种形状', () => {
    expect(summarizeScenario(ok)).toMatchObject({
      grossMargin: 0.225,
      landedCostMinor: 820,
      deadline: null,
    })
    expect(summarizeScenario({ result: ok, deadline: '2026-11-01', certainty: 0.8 })).toMatchObject(
      { grossMargin: 0.225, deadline: '2026-11-01' },
    )
  })
  it('缺输入时数字为空并列出缺失项，不按 0 显示', () => {
    expect(summarizeScenario({ status: 'missing', missing: ['weight'] })).toMatchObject({
      grossMargin: null,
      landedCostMinor: null,
      missing: ['weight'],
    })
  })
})
