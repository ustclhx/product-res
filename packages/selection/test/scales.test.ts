import { describe, expect, it } from 'vitest'
import {
  clampScore,
  coefficientOfVariation,
  inverseLogScale,
  linearScale,
  logScale,
  median,
  pearson,
  percentile,
  percentileRank,
  seasonIndexScale,
} from '../src/index.ts'

describe('映射函数边界', () => {
  it('clampScore 截断到 0–100 并保留一位小数', () => {
    expect(clampScore(-5)).toBe(0)
    expect(clampScore(120)).toBe(100)
    expect(clampScore(42.26)).toBe(42.3)
  })

  it('logScale：≤ floor 为 0，≥ ceiling 为 100，几何中点为 50', () => {
    expect(logScale(0, 1, 100)).toBe(0)
    expect(logScale(1, 1, 100)).toBe(0)
    expect(logScale(10, 1, 100)).toBe(50)
    expect(logScale(100, 1, 100)).toBe(100)
    expect(logScale(1e9, 1, 100)).toBe(100)
    expect(logScale(Number.NaN, 1, 100)).toBe(0)
  })

  it('inverseLogScale：排名越小分越高', () => {
    expect(inverseLogScale(1, 100, 10_000)).toBe(100)
    expect(inverseLogScale(1000, 100, 10_000)).toBe(50)
    expect(inverseLogScale(10_000, 100, 10_000)).toBe(0)
  })

  it('linearScale 截断且支持反向区间', () => {
    expect(linearScale(0.25, 0, 0.5)).toBe(50)
    expect(linearScale(-1, 0, 0.5)).toBe(0)
    expect(linearScale(2, 0, 0.5)).toBe(100)
    expect(linearScale(0.25, 0.5, 0)).toBe(50)
  })

  it('季节指数 1 为中性 50', () => {
    expect(seasonIndexScale(1)).toBe(50)
    expect(seasonIndexScale(0.5)).toBe(0)
    expect(seasonIndexScale(2)).toBe(100)
    expect(seasonIndexScale(1.5)).toBe(75)
  })

  it('分位、中位数、分位排名', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46)
    expect(percentileRank(30, [10, 20, 30, 40])).toBe(0.625)
    expect(percentileRank(1, [])).toBeNull()
  })

  it('变异系数与相关系数在样本不足时为 null', () => {
    expect(coefficientOfVariation([5])).toBeNull()
    expect(coefficientOfVariation([0, 0])).toBeNull()
    expect(coefficientOfVariation([10, 10])).toBe(0)
    expect(pearson([1, 2], [1, 2])).toBeNull()
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull()
  })
})
