import { describe, expect, it } from 'vitest'
import {
  type BudgetSpec,
  dailyAllowance,
  decideReservation,
  nextReset,
  periodKey,
  validateSafetyLine,
} from '../src/index.ts'

const ebay: BudgetSpec = {
  unit: 'call',
  period: 'day',
  hardCap: 5000,
  safetyLine: 4500,
  timeZone: 'America/Los_Angeles',
}
const now = new Date('2026-10-18T12:00:00Z')

describe('eBay 每日额度（specs/source-budgets）', () => {
  it('定时任务到安全线即停', () => {
    expect(decideReservation(ebay, { usedInPeriod: 4490 }, 20, 'scheduled', now)).toEqual({
      ok: false,
      limit: 4500,
      reason: 'safety-line',
    })
    expect(decideReservation(ebay, { usedInPeriod: 4480 }, 20, 'scheduled', now).ok).toBe(true)
  })

  it('人工刷新可以使用安全线到硬上限之间的余量', () => {
    expect(decideReservation(ebay, { usedInPeriod: 4500 }, 1, 'manual', now)).toEqual({
      ok: true,
      limit: 5000,
    })
  })

  it('任何调用都不超过硬上限', () => {
    expect(decideReservation(ebay, { usedInPeriod: 5000 }, 1, 'manual', now).ok).toBe(false)
    expect(decideReservation(ebay, { usedInPeriod: 4999 }, 2, 'manual', now)).toMatchObject({
      reason: 'hard-cap',
    })
  })

  it('按数据源时区划分周期并给出重置时刻', () => {
    // 2026-10-18T05:00Z 在洛杉矶仍是 10-17
    expect(periodKey(ebay, new Date('2026-10-18T05:00:00Z'))).toBe('2026-10-17')
    expect(periodKey(ebay, now)).toBe('2026-10-18')
    // 洛杉矶 10-19 00:00（夏令时 UTC−7）
    expect(nextReset(ebay, now).toISOString()).toBe('2026-10-19T07:00:00.000Z')
  })
})

describe('月度预算日分配', () => {
  const monthly: BudgetSpec = {
    unit: 'call',
    period: 'month',
    hardCap: 3300,
    safetyLine: 3000,
    timeZone: 'UTC',
  }

  it('结余滚动：(3000 − 50) ÷ 29 ≈ 101', () => {
    expect(dailyAllowance(3000, 50, 29)).toBe(101)
    // 2026-11-02：11 月 30 天，剩 29 天；前一天用了 50
    const day2 = new Date('2026-11-02T03:00:00Z')
    expect(
      decideReservation(monthly, { usedInPeriod: 50, usedToday: 0 }, 101, 'scheduled', day2).ok,
    ).toBe(true)
    expect(
      decideReservation(monthly, { usedInPeriod: 50, usedToday: 0 }, 102, 'scheduled', day2),
    ).toMatchObject({
      ok: false,
      reason: 'daily-allowance',
    })
  })

  it('先到先得模式只看月度安全线', () => {
    const fcfs = { ...monthly, monthlyAllocation: 'first-come' as const }
    expect(
      decideReservation(fcfs, { usedInPeriod: 0, usedToday: 0 }, 2999, 'scheduled', now).ok,
    ).toBe(true)
  })
})

describe('安全线校验', () => {
  it('不能超过硬上限', () => {
    expect(validateSafetyLine(ebay, 6000)).toBe('安全线不能超过硬上限 5000')
    expect(validateSafetyLine(ebay, 4000)).toBeNull()
  })
})
