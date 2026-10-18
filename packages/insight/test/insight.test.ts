import { describe, expect, it } from 'vitest'
import type { InsightProduct, InsightReview, MonthlyValue } from '../src/index.ts'
import {
  addMonths,
  competitorMatrix,
  concentration,
  countNewProducts,
  keepCitedSuggestions,
  monthlyTrend,
  priceBands,
  searchVolumeYoy,
  selectNegativeReviews,
} from '../src/index.ts'

const ref = { sourceId: 's1', method: 'api', at: '2026-10-01T00:00:00Z' }
const mv = (month: string, value: number, sourceId = 's1'): MonthlyValue => ({
  ...ref,
  sourceId,
  month,
  value,
})
const sv = (value: number, sourceId = 's1') => ({ ...ref, sourceId, value })
const range = (from: string, n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => mv(addMonths(from, i), f(i)))

describe('searchVolumeYoy', () => {
  it('完整 24 个月：最近 12 个月 ÷ 前 12 个月 − 1', () => {
    const series = [...range('2024-10', 12, () => 100), ...range('2025-10', 12, () => 150)]
    const r = searchVolumeYoy(series)
    expect(r?.yoy).toBeCloseTo(0.5)
    expect(r?.coveredMonths).toBe(12)
    expect(r?.endMonth).toBe('2026-09')
  })

  it('去年缺 3 个月：只用双方都有的 9 个月并标注覆盖 9 个月', () => {
    const prev = range('2024-10', 12, () => 100).filter(
      (p) => !['2025-01', '2025-02', '2025-03'].includes(p.month),
    )
    const r = searchVolumeYoy([...prev, ...range('2025-10', 12, () => 200)])
    expect(r?.coveredMonths).toBe(9)
    expect(r?.currentSum).toBe(1800)
    expect(r?.previousSum).toBe(900)
    expect(r?.yoy).toBeCloseTo(1)
  })

  it('没有重叠月份或无数据返回 null，不是 0', () => {
    expect(searchVolumeYoy([])).toBeNull()
    expect(searchVolumeYoy(range('2026-01', 6, () => 100))).toBeNull()
  })

  it('前期合计为 0 无法相除返回 null；非有限值被忽略', () => {
    const series = [...range('2024-10', 12, () => 0), ...range('2025-10', 12, () => 10)]
    expect(searchVolumeYoy(series)).toBeNull()
    expect(searchVolumeYoy([mv('2026-01', Number.NaN)])).toBeNull()
  })
})

describe('countNewProducts', () => {
  const now = '2026-10-19T00:00:00Z'
  it('按 listedAt 优先、缺失用 firstSeenAt，并给出口径', () => {
    const r = countNewProducts(
      [
        { id: 'a', listedAt: '2026-09-01T00:00:00Z' },
        { id: 'b', listedAt: '2025-01-01T00:00:00Z', firstSeenAt: '2026-10-01T00:00:00Z' },
        { id: 'c', firstSeenAt: '2026-08-01T00:00:00Z' },
        { id: 'd', firstSeenAt: '2026-10-10T00:00:00Z' },
        { id: 'e' },
      ],
      { now },
    )
    expect(r.count).toBe(3)
    expect(r.byListedAt).toBe(1)
    expect(r.byFirstSeenAt).toBe(2)
    expect(r.excluded).toBe(1)
    expect(r.basis).toContain('90')
  })

  it('全部没有日期时 count 为 null', () => {
    expect(countNewProducts([{ id: 'a' }], { now }).count).toBeNull()
    expect(countNewProducts([], { now }).count).toBeNull()
  })
})

const withPrice = (id: string, price: number | null, sales: number | null): InsightProduct => ({
  id,
  price: price === null ? null : sv(price),
  salesMonthly: sales === null ? null : sv(sales),
})

describe('priceBands', () => {
  const products = Array.from({ length: 12 }, (_, i) => withPrice(`p${i}`, (i + 1) * 10, 100))

  it('自定义边界：6 档，商品数与销量占比', () => {
    const r = priceBands(products, { boundaries: [20, 40, 60, 80, 100] })
    expect(r?.bands).toHaveLength(6)
    expect(r?.bands.map((b) => b.productCount)).toEqual([1, 2, 2, 2, 2, 3])
    expect(r?.bands[0]?.min).toBeNull()
    expect(r?.bands[5]?.max).toBeNull()
    expect(r?.bands[5]?.salesShare).toBeCloseTo(3 / 12)
  })

  it('默认按分位自动边界', () => {
    const r = priceBands(products)
    expect(r?.boundaries).toHaveLength(5)
    expect(r?.bands.reduce((s, b) => s + b.productCount, 0)).toBe(12)
    expect(r?.custom).toBe(false)
  })

  it('缺价格不计入并返回被排除数量；缺销量不进占比分母', () => {
    const r = priceBands(
      [withPrice('a', 10, 50), withPrice('b', null, 50), withPrice('c', 30, null)],
      { boundaries: [20, 40, 60, 80, 100] },
    )
    expect(r?.excludedNoPrice).toBe(1)
    expect(r?.missingSales).toBe(1)
    expect(r?.bands[0]?.salesShare).toBe(1)
    expect(r?.bands[1]?.productCount).toBe(1)
    expect(r?.bands[1]?.salesShare).toBe(0)
  })

  it('没有任何销量估算时占比为 null；没有价格返回 null；非法边界抛错', () => {
    expect(priceBands([withPrice('a', 10, null)])?.bands[0]?.salesShare).toBeNull()
    expect(priceBands([withPrice('a', null, 1)])).toBeNull()
    expect(() => priceBands([withPrice('a', 10, 1)], { boundaries: [1, 2, 3] })).toThrow(RangeError)
    expect(() => priceBands([withPrice('a', 10, 1)], { boundaries: [1, 2, 2, 4, 5] })).toThrow(
      RangeError,
    )
  })
})

describe('concentration', () => {
  const sales = [50, 30, 10, 5, 5]

  it('CR3 / CR10 按销量估算；样本不足 10 个时 CR10 = 100%', () => {
    const r = concentration(sales.map((s, i) => withPrice(`p${i}`, 10, s)))
    expect(r?.cr3).toBeCloseTo(0.9)
    expect(r?.cr10).toBe(1)
    expect(r?.sampleSize).toBe(5)
  })

  it('单一来源标未交叉验证，多来源则已验证', () => {
    const single = concentration(sales.map((s, i) => withPrice(`p${i}`, 10, s)))
    expect(single?.crossValidated).toBe(false)
    const multi = concentration([
      { id: 'a', salesMonthly: sv(10, 's1') },
      { id: 'b', salesMonthly: sv(20, 's2') },
    ])
    expect(multi?.crossValidated).toBe(true)
    expect(multi?.sourceIds).toEqual(['s1', 's2'])
  })

  it('缺销量估算的不参与并计数；全缺返回 null；合计为 0 时占比 null', () => {
    const r = concentration([withPrice('a', 1, 10), withPrice('b', 1, null)])
    expect(r?.excluded).toBe(1)
    expect(concentration([withPrice('a', 1, null)])).toBeNull()
    expect(concentration([withPrice('a', 1, 0)])?.cr3).toBeNull()
  })
})

describe('competitorMatrix', () => {
  const products: InsightProduct[] = [
    {
      id: 'a',
      title: 'A',
      price: sv(10),
      rating: sv(4.5),
      reviewCount: sv(100),
      salesMonthly: sv(500),
    },
    { id: 'b', price: sv(20), salesMonthly: sv(900) },
    { id: 'c', price: sv(30), rating: sv(3.9) },
    { id: 'd', salesMonthly: sv(300), reviewCount: sv(7) },
  ]

  it('头部 N 按销量降序，缺值保持 null，缺销量排最后', () => {
    const r = competitorMatrix(products, { topN: 3 })
    expect(r.rows.map((x) => x.id)).toEqual(['b', 'a', 'd'])
    expect(r.rows[0]?.rating).toBeNull()
    expect(r.rows[0]?.reviewCount).toBeNull()
    expect(competitorMatrix(products).rows.map((x) => x.id)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('气泡图 x=价格 y=月销量估算 size=评论数；缺价格或销量的跳过并计数，缺评论数 size 为 null', () => {
    const r = competitorMatrix(products)
    expect(r.bubbles).toEqual([
      { id: 'b', x: 20, y: 900, size: null },
      { id: 'a', x: 10, y: 500, size: 100 },
    ])
    expect(r.bubblesSkipped).toBe(2)
  })
})

describe('selectNegativeReviews', () => {
  const rv = (id: string, rating: number | null, body = 'text'): InsightReview => ({
    id,
    productId: 'p1',
    rating,
    title: `t-${id}`,
    body,
    sourceId: 'rs',
  })

  it('没有评论返回 no-source', () => {
    expect(selectNegativeReviews([])).toEqual({ status: 'no-source' })
  })

  it('只保留评分 ≤ 3，缺评分单独计数；有评论但无差评是 ok 且为空', () => {
    const r = selectNegativeReviews([rv('1', 5), rv('2', 3), rv('3', 1), rv('4', null)])
    expect(r).toMatchObject({
      status: 'ok',
      negativeCount: 2,
      excludedNoRating: 1,
      totalReviews: 4,
    })
    if (r.status === 'ok') expect(r.items.map((i) => i.id)).toEqual(['2', '3'])
    const none = selectNegativeReviews([rv('1', 5)])
    expect(none).toMatchObject({ status: 'ok', items: [], negativeCount: 0 })
  })

  it('正文按可配置长度截断并标记', () => {
    const r = selectNegativeReviews([rv('1', 2, 'abcdefghij')], { maxBodyChars: 4 })
    if (r.status !== 'ok') throw new Error('unexpected')
    expect(r.items[0]).toMatchObject({ body: 'abcd…', truncated: true })
    const r2 = selectNegativeReviews([rv('1', 2, 'abc')], { maxBodyChars: 4 })
    if (r2.status === 'ok') expect(r2.items[0]?.truncated).toBe(false)
  })

  it('maxReviews 限制条数但 negativeCount 保持真实', () => {
    const r = selectNegativeReviews([rv('1', 1), rv('2', 1), rv('3', 1)], { maxReviews: 2 })
    if (r.status !== 'ok') throw new Error('unexpected')
    expect(r.items).toHaveLength(2)
    expect(r.negativeCount).toBe(3)
  })
})

describe('monthlyTrend', () => {
  it('按月对齐，缺月为 null，节点落到对应月份', () => {
    const t = monthlyTrend(
      range('2025-10', 12, (i) => i + 1).filter((p) => p.month !== '2026-01'),
      [mv('2026-09', 70)],
      {
        nodes: [
          { date: '2025-11-28', label: '黑五' },
          { date: '2024-01', label: '窗口外' },
        ],
      },
    )
    expect(t).toHaveLength(12)
    expect(t[0]?.month).toBe('2025-10')
    expect(t[11]?.month).toBe('2026-09')
    expect(t.find((p) => p.month === '2026-01')?.searchVolume).toBeNull()
    expect(t[0]?.salesEstimate).toBeNull()
    expect(t[11]?.salesEstimate).toBe(70)
    expect(t[1]?.nodes.map((n) => n.label)).toEqual(['黑五'])
    expect(t.flatMap((p) => p.nodes)).toHaveLength(1)
  })

  it('无数据返回空数组', () => {
    expect(monthlyTrend([], [])).toEqual([])
  })
})

describe('keepCitedSuggestions', () => {
  it('丢弃没有有效引用的建议，并剔除无效引用', () => {
    const valid = new Set(['r1', 'p1'])
    const { kept, dropped } = keepCitedSuggestions(
      [
        { text: 'A', citations: ['r1', 'x9'] },
        { text: 'B', citations: [] },
        { text: 'C', citations: ['nope'] },
        { text: 'D', citations: ['p1', 'p1'] },
      ],
      valid,
    )
    expect(kept).toEqual([
      { text: 'A', citations: ['r1'] },
      { text: 'D', citations: ['p1'] },
    ])
    expect(dropped.map((d) => d.text)).toEqual(['B', 'C'])
  })
})
