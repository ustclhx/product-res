import { describe, expect, it } from 'vitest'
import {
  amazonBoughtInterval,
  formatInterval,
  logMidpoint,
  nextAmazonBoughtTier,
  parseBoughtText,
  TIER_BY_METHOD,
  tierOf,
} from '../src/index.ts'

describe('Amazon bought 档位', () => {
  it.each([
    [0, 50],
    [49, 50],
    [50, 100],
    [99, 100],
    [100, 200],
    [600, 700],
    [900, 1000],
    [1000, 2000],
    [7000, 8000],
    [9000, 10000],
    [10000, 20000],
    [90000, 100000],
    [100000, 200000],
  ])('下界 %i 的下一档为 %i', (low, high) => {
    expect(nextAmazonBoughtTier(low)).toBe(high)
  })

  it('拒绝负数', () => {
    expect(() => nextAmazonBoughtTier(-1)).toThrow(RangeError)
  })

  it('"100+ bought" → [100, 200)，value 为对数中点，不是下界', () => {
    const interval = amazonBoughtInterval(100)
    expect(interval).toMatchObject({ valueLow: 100, valueHigh: 200 })
    expect(interval.value).toBeCloseTo(Math.sqrt(100 * 200))
    expect(interval.value).toBeGreaterThan(100)
    expect(interval.value).toBeLessThan(200)
  })

  it('对数中点：下界为 0 时取算术中点，上界开放时取下界', () => {
    expect(logMidpoint(0, 50)).toBe(25)
    expect(logMidpoint(10000, null)).toBe(10000)
    expect(() => logMidpoint(10, 5)).toThrow(RangeError)
  })
})

describe('徽标文本解析', () => {
  it.each([
    ['7K+ bought in past month', 7000],
    ['100+ bought in past month', 100],
    ['50+ bought in past month', 50],
    ['1.5K+ bought', 1500],
    ['1M+ bought in past month', 1_000_000],
  ])('%s → %i', (text, value) => {
    expect(parseBoughtText(text)).toBe(value)
  })

  it.each([[null], [undefined], [''], ['bought in past month'], ['0+ bought']])(
    '无法识别时为缺失：%s',
    (text) => {
      expect(parseBoughtText(text)).toBeNull()
    },
  )
})

describe('区间展示', () => {
  it('显示区间而不是下界', () => {
    expect(formatInterval(100, 200)).toBe('100–200')
    expect(formatInterval(1000, 2000)).toBe('1K–2K')
    expect(formatInterval(10000, null)).toBe('10K+')
    expect(formatInterval(null, null, 19.99)).toBe('19.99')
  })
})

describe('可信度层级', () => {
  it('按获取方式回填：official→1、import→2、estimate→3、derived→4', () => {
    expect(TIER_BY_METHOD).toEqual({ official: 1, import: 2, estimate: 3, derived: 4 })
  })

  it('显式层级优先于获取方式', () => {
    expect(tierOf({ method: 'official' })).toBe(1)
    expect(tierOf({ method: 'official', tier: 2 })).toBe(2)
    expect(tierOf({ method: 'import', tier: 0 })).toBe(0)
  })
})
