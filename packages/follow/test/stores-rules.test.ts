import { createConnectors } from '@product-res/connectors'
import type { SourceConnector } from '@product-res/datasources'
import { describe, expect, it } from 'vitest'
import {
  computeStoreMetrics,
  decideTier,
  lastChangeOn,
  matchOffers,
  orderEnrollment,
  parseStoreLink,
  planStoreTasks,
  roseWithin,
  type SourceAllowance,
  type StoreListingFacts,
  saleSignal,
  storeKeywords,
} from '../src/index.ts'

// add-accuracy-store-tracking tasks 3.1–3.3 的纯函数：链接解析、档位、出单信号、店铺指标与采集计划。

describe('店铺链接解析', () => {
  it.each([
    ['https://www.ebay.com/str/kitchenpro', 'ebay', 'ebay-us', 'kitchenpro', 'ebay-store'],
    ['ebay.com/usr/kitchen_pro-1', 'ebay', 'ebay-us', 'kitchen_pro-1', 'ebay-user'],
    ['https://m.ebay.com/usr/kitchen.pro?_trksid=1', 'ebay', 'ebay-us', 'kitchen.pro', 'ebay-user'],
    [
      'https://www.ebay.com/sch/i.html?_ssn=kitchen_pro&_ipg=60',
      'ebay',
      'ebay-us',
      'kitchen_pro',
      'ebay-search',
    ],
    ['https://www.amazon.com/sp?seller=A1B2C3', 'amazon', 'amazon-us', 'A1B2C3', 'amazon-seller'],
    [
      'https://www.amazon.com/s?me=a2xyz9q8w7&marketplaceID=ATVPDKIKX0DER',
      'amazon',
      'amazon-us',
      'A2XYZ9Q8W7',
      'amazon-seller',
    ],
    [
      'https://www.amazon.co.uk/gp/aag/main?seller=A1B2C3D4',
      'amazon',
      'amazon-uk',
      'A1B2C3D4',
      'amazon-seller',
    ],
  ])('识别 %s', (url, platform, marketplace, sellerKey, form) => {
    const parsed = parseStoreLink(url)
    expect(parsed).toMatchObject({ ok: true, platform, marketplace, sellerKey, form })
  })

  it('带 seller= 的 Amazon 链接规范化为卖家页', () => {
    expect(parseStoreLink('amazon.com/s?seller=A1B2C3')).toMatchObject({
      ok: true,
      url: 'https://www.amazon.com/sp?seller=A1B2C3',
    })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a link', 'invalid-url'],
    ['ftp://ebay.com/str/a', 'invalid-url'],
    ['https://www.amazon.com/dp/B0C1234567', 'not-a-store'],
    ['https://www.ebay.com/itm/1234567890', 'not-a-store'],
    ['https://www.amazon.com/s?k=spice+rack', 'not-a-store'],
    ['https://www.amazon.com/sp?seller=<script>', 'not-a-store'],
    ['https://www.ebay.co.uk/str/kitchenpro', 'unsupported-site'],
    ['https://notebay.com/str/kitchenpro', 'unsupported-site'],
    ['https://www.walmart.com/seller/123', 'unsupported-site'],
  ])('无法识别 %j → %s，不猜测', (url, reason) => {
    expect(parseStoreLink(url)).toEqual({ ok: false, reason })
  })
})

describe('档位升降', () => {
  const base = { tierChangedOn: '2031-05-01', lastChangeOn: null, today: '2031-06-10' }
  it('普通档 bought 区间 7 天内上升 → 热点并记录原因', () => {
    expect(decideTier({ ...base, tier: 'normal', up: new Set(['bought-up']) })).toEqual({
      tier: 'hot',
      reason: 'bought-up',
    })
  })
  it('冷门商品出现出单信号也升为热点；已是热点时不变', () => {
    expect(decideTier({ ...base, tier: 'cold', up: new Set(['sale-signal']) })?.tier).toBe('hot')
    expect(decideTier({ ...base, tier: 'hot', up: new Set(['new-lead']) })).toBeNull()
  })
  it('30 天无变化降一档，冷门停在冷门', () => {
    expect(decideTier({ ...base, tier: 'hot', up: new Set() })).toEqual({
      tier: 'normal',
      reason: 'stale-30d',
    })
    expect(decideTier({ ...base, tier: 'normal', up: new Set() })?.tier).toBe('cold')
    expect(decideTier({ ...base, tier: 'cold', up: new Set() })).toBeNull()
  })
  it('近期有变化或刚换档不降档', () => {
    expect(
      decideTier({ ...base, tier: 'hot', up: new Set(), lastChangeOn: '2031-05-20' }),
    ).toBeNull()
    expect(
      decideTier({ ...base, tier: 'normal', up: new Set(), tierChangedOn: '2031-06-01' }),
    ).toBeNull()
  })
  it('上升判断只比较窗口开始前的值，首次观测不算上升', () => {
    const points = [
      { observedOn: '2031-06-01', value: 50 },
      { observedOn: '2031-06-08', value: 100 },
    ]
    expect(roseWithin(points, '2031-06-10', 7)).toBe(true)
    expect(roseWithin(points.slice(1), '2031-06-10', 7)).toBe(false)
    expect(
      roseWithin([{ observedOn: '2031-06-01', value: 100 }, ...points.slice(1)], '2031-06-10', 7),
    ).toBe(false)
    expect(lastChangeOn([points, [{ observedOn: '2031-06-09', value: 3 }]])).toBe('2031-06-08')
  })
})

describe('出单信号', () => {
  it('Amazon：bought 下界首次 ≥ 50 的日期', () => {
    expect(
      saleSignal({
        platform: 'amazon',
        firstSeenOn: '2031-06-01',
        bought: [
          { observedOn: '2031-06-05', low: 50, high: 100 },
          { observedOn: '2031-06-03', low: 0, high: 50 },
        ],
      }),
    ).toEqual({ on: '2031-06-05', kind: 'amazon-bought', valueLow: 50, valueHigh: 100 })
    expect(saleSignal({ platform: 'amazon', firstSeenOn: '2031-06-01', bought: [] })).toBeNull()
  })
  it('eBay：自首次发现起累计已售增量 ≥ 5；没有累计值时按可售量减少推算，补货不计', () => {
    expect(
      saleSignal({
        platform: 'ebay',
        firstSeenOn: '2031-06-02',
        sold: [
          { observedOn: '2031-06-01', value: 10 },
          { observedOn: '2031-06-04', value: 14 },
          { observedOn: '2031-06-06', value: 15 },
        ],
      }),
    ).toMatchObject({ on: '2031-06-06', kind: 'ebay-sold', valueLow: 5 })
    expect(
      saleSignal({
        platform: 'ebay',
        firstSeenOn: '2031-06-01',
        available: [
          { observedOn: '2031-06-01', value: 10 },
          { observedOn: '2031-06-02', value: 7 },
          { observedOn: '2031-06-03', value: 20 },
          { observedOn: '2031-06-04', value: 18 },
        ],
      }),
    ).toMatchObject({ on: '2031-06-04', valueLow: 5 })
    expect(
      saleSignal({
        platform: 'ebay',
        firstSeenOn: '2031-06-01',
        sold: [
          { observedOn: '2031-06-01', value: 1 },
          { observedOn: '2031-06-02', value: 4 },
        ],
      }),
    ).toBeNull()
  })
})

describe('店铺指标', () => {
  const listing = (i: number, firstSeenOn: string, extra: Partial<StoreListingFacts> = {}) => ({
    productId: `p${i}`,
    firstSeenOn,
    delistedOn: null,
    categoryId: 'c1',
    signalOn: null,
    sales: null,
    ...extra,
  })

  it('新店铺只发现 3 个新品：命中率等全部为空，不显示 0%', () => {
    const metrics = computeStoreMetrics(
      [1, 2, 3].map((i) => listing(i, '2031-06-01')),
      '2031-06-10',
    )
    expect(metrics).toEqual({
      newPerWeek: null,
      survivalRate: null,
      hitRate: null,
      salesSum: null,
      directionShift: null,
      sample: 3,
    })
  })

  it('样本足够时计算上新速度、存活率、命中率与出单区间合计', () => {
    const rows = [
      listing(1, '2031-04-01', { signalOn: '2031-04-10', sales: { low: 50, high: 100 } }),
      listing(2, '2031-04-01', { delistedOn: '2031-04-10', sales: { low: 100, high: 200 } }),
      listing(3, '2031-04-02', { sales: { low: 0, high: 50 } }),
      listing(4, '2031-04-03', { sales: { low: 1000, high: 2000 } }),
      listing(5, '2031-04-05', { signalOn: '2031-06-01', sales: { low: 50, high: 100 } }),
      listing(6, '2031-06-05', { signalOn: '2031-06-08' }),
    ]
    const metrics = computeStoreMetrics(rows, '2031-06-10')
    expect(metrics.newPerWeek).toBe(0.25)
    // 满 30 天的 5 个中 1 个在 30 天内下架
    expect(metrics.survivalRate).toBe(0.8)
    // 分母：满 30 天的 5 个 + 窗口内已命中的 1 个；命中：p1、p6（p5 的信号超出 30 天）
    expect(metrics.hitRate).toBe(Math.round((2 / 6) * 10_000) / 10_000)
    expect(metrics.salesSum).toEqual({ low: 1200, high: 2450 })
    expect(metrics.directionShift).toBeNull()
  })

  it('方向迁移：近 30 天新品类目分布与之前 90 天的总变差距离', () => {
    const recent = [1, 2, 3, 4, 5].map((i) => listing(i, '2031-06-05', { categoryId: 'new' }))
    const prior = [6, 7, 8, 9, 10].map((i) => listing(i, '2031-04-15', { categoryId: 'old' }))
    expect(computeStoreMetrics([...recent, ...prior], '2031-06-10').directionShift).toBe(1)
  })
})

describe('报价归属', () => {
  it('卖家 ID 不区分大小写匹配，没有 ID 时按显示名匹配；Amazon 自营不归属', () => {
    const stores = [
      { sellerKey: 'A1B2C3', displayName: 'Kitchen Pro' },
      { sellerKey: 'Z9', displayName: null },
    ]
    expect(
      matchOffers(
        [
          { productRef: 'p1', sellerId: 'a1b2c3', sellerName: 'whatever' },
          { productRef: 'p2', sellerName: 'kitchen pro' },
          { productRef: 'p3', sellerName: 'Amazon.com' },
          { productRef: 'p1', sellerId: 'A1B2C3' },
        ],
        stores,
      ),
    ).toEqual([
      { productRef: 'p1', sellerKey: 'A1B2C3' },
      { productRef: 'p2', sellerKey: 'A1B2C3' },
    ])
  })
})

describe('店铺采集计划', () => {
  const connectors = new Map(createConnectors().map((c) => [c.id, c]))
  const allowance = (id: string, headroom: number): SourceAllowance => ({
    connector: connectors.get(id) as SourceConnector,
    headroom,
  })
  const targets = {
    searches: [{ marketplace: 'amazon-us', keyword: 'spice rack' }],
    sellers: [{ marketplace: 'ebay-us', sellerId: 'shop', categoryIds: [], keywords: ['rack'] }],
    snapshots: [
      ...Array.from({ length: 12 }, (_, i) => ({
        productId: `h${i}`,
        marketplace: 'amazon-us',
        platformId: `B0HOT${String(i).padStart(5, '0')}`,
        tier: 'hot' as const,
        crossPriority: i === 11 ? 0 : 1,
        workspaceIds: ['w'],
      })),
      {
        productId: 'n1',
        marketplace: 'amazon-us',
        platformId: 'B0NORMAL001',
        tier: 'normal' as const,
        crossPriority: 1,
        workspaceIds: ['w'],
      },
      {
        productId: 'e1',
        marketplace: 'ebay-us',
        platformId: '1234',
        tier: 'normal' as const,
        crossPriority: 1,
        workspaceIds: ['w'],
      },
    ],
  }

  it('热点快照优先于搜索，普通档最后；按额度严格截断，SerpApi 线索优先', () => {
    // DataForSEO：每个 ASIN / 关键词预扣 6000 微美元；够 12 个热点 + 1 次搜索
    const plan = planStoreTasks(
      targets,
      new Map([
        ['dataforseo', allowance('dataforseo', 13 * 6000)],
        ['serpapi', allowance('serpapi', 2)],
      ]),
    )
    const dfs = plan.tasks.filter((t) => t.sourceId === 'dataforseo')
    expect(dfs.map((t) => t.task.kind)).toEqual(['amazon-asin', 'amazon-asin', 'amazon-search'])
    expect(dfs[0]?.task.scope.ids).toHaveLength(10)
    expect(plan.truncated).toEqual({ dataforseo: 1, serpapi: 10 })
    const serp = plan.tasks.filter((t) => t.sourceId === 'serpapi')
    expect(serp.map((t) => t.task.scope.ids)).toEqual([['B0HOT00011'], ['B0HOT00000']])
    // eBay 未配置：eBay 店铺与快照记为不可用，Amazon 照常
    expect(plan.unavailable).toEqual({ 'ebay-browse': 2 })
  })

  it('店铺搜索词：自有优先，为空时取关联的启用方向关键词，最多 5 个', () => {
    const directions = new Map([
      ['d1', { keywords: ['A', 'b', 'c'], enabled: true }],
      ['d2', { keywords: ['x'], enabled: false }],
      ['d3', { keywords: ['d', 'e', 'f'], enabled: true }],
    ])
    expect(storeKeywords({ keywords: ['Own Word'], directionIds: ['d1'] }, directions)).toEqual([
      'own word',
    ])
    expect(storeKeywords({ keywords: [], directionIds: ['d1', 'd2', 'd3'] }, directions)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
  })
})

// 实测修正（2026-10-23）：名额不被头部店铺占满。
describe('加入追踪的公平顺序', () => {
  const items = (prefix: string, n: number, firstSeenOn = '2026-10-20') =>
    Array.from({ length: n }, (_, i) => ({
      productId: `${prefix}${String(i).padStart(3, '0')}`,
      firstSeenOn,
      listedOn: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`,
    }))
  const take = (list: ReturnType<typeof orderEnrollment>, room: number) => list.slice(0, room)

  it('头部店铺候选再多，各店铺也按轮询分到名额', () => {
    const order = orderEnrollment({
      stores: [
        { storeId: 's1', items: items('a', 900) },
        { storeId: 's2', items: items('b', 90) },
        { storeId: 's3', items: items('c', 7) },
      ],
      leads: [],
      tracked: new Set(),
      room: 100,
    })
    const picked = take(order, 100)
    const count = (id: string) => picked.filter((c) => c.originRef === id).length
    // s3 只有 7 个，余下名额在 s1、s2 间继续轮询
    expect(count('s3')).toBe(7)
    expect(count('s1')).toBeGreaterThanOrEqual(33)
    expect(count('s2')).toBeGreaterThanOrEqual(33)
    expect(Math.abs(count('s1') - count('s2'))).toBeLessThanOrEqual(1)
  })

  it('店铺内首次发现日新到旧，其次上架日新到旧，未知上架日排后', () => {
    const order = orderEnrollment({
      stores: [
        {
          storeId: 's1',
          items: [
            { productId: 'old', firstSeenOn: '2026-10-01', listedOn: '2026-10-01' },
            { productId: 'unknown', firstSeenOn: '2026-10-20', listedOn: null },
            { productId: 'listed-late', firstSeenOn: '2026-10-20', listedOn: '2026-10-19' },
            { productId: 'listed-early', firstSeenOn: '2026-10-20', listedOn: '2026-10-02' },
          ],
        },
      ],
      leads: [],
      tracked: new Set(),
      room: 10,
    })
    expect(order.map((c) => c.productId)).toEqual(['listed-late', 'listed-early', 'unknown', 'old'])
  })

  it('线索商品排在每店保底 floor(room/店铺数) 之后、剩余轮询之前；已追踪与重复跳过', () => {
    const order = orderEnrollment({
      stores: [
        { storeId: 's1', items: items('a', 10) },
        { storeId: 's2', items: items('b', 10) },
      ],
      leads: ['lead1', 'a000', 'tracked', 'lead2'],
      tracked: new Set(['tracked', 'b001']),
      room: 6,
    })
    const picked = take(order, 6)
    // 保底 3 + 3，线索紧随其后
    expect(picked.filter((c) => c.origin === 'store')).toHaveLength(6)
    expect(order.slice(6, 8)).toEqual([
      { productId: 'lead1', origin: 'lead', originRef: null },
      { productId: 'lead2', origin: 'lead', originRef: null },
    ])
    expect(order.map((c) => c.productId)).not.toContain('b001')
    expect(order.map((c) => c.productId)).not.toContain('tracked')
    expect(order.filter((c) => c.productId === 'a000')).toHaveLength(1)
    expect(order).toHaveLength(10 + 9 + 2)
  })

  it('名额少于店铺数时线索先于店铺，店铺按顺序各取一个', () => {
    const order = orderEnrollment({
      stores: [
        { storeId: 's1', items: items('a', 3) },
        { storeId: 's2', items: items('b', 3) },
        { storeId: 's3', items: items('c', 3) },
      ],
      leads: ['lead1'],
      tracked: new Set(),
      room: 2,
    })
    expect(order.slice(0, 4).map((c) => c.originRef ?? c.productId)).toEqual([
      'lead1',
      's1',
      's2',
      's3',
    ])
  })
})
