import { readFileSync } from 'node:fs'
import type { FetchTask, RawPayload } from '@product-res/datasources'
import { describe, expect, it } from 'vitest'
import {
  createConnectors,
  createEbayBrowseConnector,
  createKeepaConnector,
  dailySalesFromTotals,
  derivedDailySales,
  freshListings,
  keepaTimeToDate,
  normalizeDataForSeo,
  normalizeEbay,
  normalizeKeepa,
  normalizeRates,
} from '../src/index.ts'

const payload = (
  task: FetchTask,
  body: unknown,
  fetchedAt = '2026-10-18T03:00:00.000Z',
): RawPayload => ({
  sourceId: 'test',
  task,
  request: { method: 'GET', url: 'https://example.invalid' },
  status: 200,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  fetchedAt,
})

describe('汇率（ECB 真实响应）', () => {
  it('把 EUR 基准换算为 {币种}/CNY', () => {
    const csv = readFileSync(new URL('./fixtures/ecb-rates.csv', import.meta.url), 'utf8')
    const batch = normalizeRates(
      payload({ kind: 'fx-rate', marketplace: 'global', scope: {} }, csv),
    )
    const usd = batch.observations.filter((o) => o.entity.platformId === 'USD/CNY')
    expect(usd.length).toBe(2)
    for (const o of usd) expect(o.value).toBeGreaterThan(5)
    expect(
      batch.observations.find((o) => o.entity.platformId === 'EUR/CNY')?.value,
    ).toBeGreaterThan(7)
    expect(batch.observations.every((o) => o.method === 'official')).toBe(true)
  })
})

// 以下样例按官方文档的响应结构编写（不是真实回执）；拿到凭据后以真实响应替换
describe('eBay Browse（文档样例）', () => {
  const search = {
    href: 'x',
    total: 250,
    next: 'https://api.ebay.com/buy/browse/v1/item_summary/search?offset=200',
    limit: 200,
    offset: 0,
    itemSummaries: [
      {
        itemId: 'v1|1001|0',
        title: 'Back seat organizer',
        price: { value: '19.99', currency: 'USD' },
        seller: { username: 'acme_store' },
        itemCreationDate: '2026-10-17T08:00:00.000Z',
        itemWebUrl: 'https://www.ebay.com/itm/1001',
      },
      { itemId: 'v1|1002|0', title: 'Cup holder', price: { value: '9.50', currency: 'USD' } },
    ],
  }

  it('搜索结果：实体、价格与下一页游标', () => {
    const batch = normalizeEbay(
      payload(
        { kind: 'seller-new-listings', marketplace: 'ebay-us', scope: { sellerId: 'acme_store' } },
        search,
      ),
    )
    expect(batch.entities.map((e) => e.key.platformId)).toEqual(['v1|1001|0', 'v1|1002|0'])
    expect(batch.entities[0]?.facts).toMatchObject({
      sellerId: 'acme_store',
      listedAt: '2026-10-17T08:00:00.000Z',
    })
    expect(batch.observations[0]).toMatchObject({ metric: 'price', value: 19.99, currency: 'USD' })
    expect(batch.nextCursor).toBe('200')
  })

  it('遇到已发现过的商品停止翻页', () => {
    const batch = normalizeEbay(
      payload({ kind: 'seller-new-listings', marketplace: 'ebay-us', scope: {} }, search),
    )
    expect(freshListings(batch, new Set(['v1|1002|0']))).toEqual({
      fresh: ['v1|1001|0'],
      continue: false,
    })
    expect(freshListings(batch, new Set())).toEqual({
      fresh: ['v1|1001|0', 'v1|1002|0'],
      continue: true,
    })
  })

  it('getItems：可售量与（如有）已售量为官方值', () => {
    const batch = normalizeEbay(
      payload(
        { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids: ['v1|1001|0'] } },
        {
          items: [
            {
              itemId: 'v1|1001|0',
              brand: 'Unbranded',
              estimatedAvailabilities: [
                { estimatedAvailableQuantity: 37, estimatedSoldQuantity: 120 },
              ],
              price: { value: '19.99', currency: 'USD' },
            },
          ],
        },
      ),
    )
    expect(batch.observations.map((o) => [o.metric, o.value])).toEqual([
      ['price', 19.99],
      ['available_quantity', 37],
      ['sold_quantity_total', 120],
    ])
  })

  it('已售量推算：补货当天为缺失，不记 0 或负数', () => {
    expect(derivedDailySales(50, 42)).toBe(8)
    expect(derivedDailySales(50, 80)).toBeNull()
    expect(derivedDailySales(undefined, 80)).toBeNull()
    expect(dailySalesFromTotals(120, 126)).toBe(6)
    expect(dailySalesFromTotals(126, 120)).toBeNull()
  })

  it('getItems 按 20 个一批计费；单个查询模式按个数', () => {
    const ebay = createEbayBrowseConnector()
    const ids = Array.from({ length: 41 }, (_, i) => String(i))
    expect(ebay.plan({ kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids } })).toBe(3)
    expect(
      ebay.plan({
        kind: 'product-snapshot',
        marketplace: 'ebay-us',
        scope: { ids, mode: 'single' },
      }),
    ).toBe(41)
    expect(ebay.budget).toMatchObject({ hardCap: 5000, safetyLine: 4500 })
  })

  it('未配置凭据时核验报告“未配置”，不发请求', async () => {
    const receipt = await createEbayBrowseConnector().probe({
      fetch: (() => {
        throw new Error('should not fetch')
      }) as unknown as typeof fetch,
      secret: () => undefined,
      now: () => new Date(),
    })
    expect(receipt.credentials).toBe('missing')
  })
})

describe('Keepa（文档样例）', () => {
  it('keepa 时间换算', () => {
    expect(keepaTimeToDate(0).toISOString()).toBe('2011-01-01T00:00:00.000Z')
  })

  it('快照取 stats.current，价格单位为分，-1 为无数据', () => {
    const current = Array(20).fill(-1)
    current[1] = 1999
    current[3] = 5321
    current[11] = 8
    current[16] = 45
    const batch = normalizeKeepa(
      payload(
        { kind: 'product-snapshot', marketplace: 'amazon-us', scope: { ids: ['B07RNZV64Y'] } },
        {
          tokensLeft: 12,
          products: [
            { asin: 'B07RNZV64Y', title: 'Seat organizer', brand: 'Helteko', stats: { current } },
          ],
        },
      ),
    )
    expect(Object.fromEntries(batch.observations.map((o) => [o.metric, o.value]))).toEqual({
      price: 19.99,
      bsr: 5321,
      seller_count: 8,
      rating: 4.5,
    })
    expect(batch.observations.find((o) => o.metric === 'price')?.currency).toBe('USD')
  })

  it('历史：每天取最后一个点，BSR 原样保存', () => {
    const day1 = Date.UTC(2026, 9, 16, 1) / 60_000 - 21_564_000
    const day1Late = day1 + 600
    const day2 = day1 + 24 * 60
    const csv: (number[] | null)[] = Array(20).fill(null)
    csv[3] = [day1, 9000, day1Late, 8800, day2, -1]
    const batch = normalizeKeepa(
      payload(
        { kind: 'rank-history', marketplace: 'amazon-us', scope: { ids: ['B0'] } },
        { products: [{ asin: 'B0', csv }] },
      ),
    )
    expect(batch.observations).toEqual([
      expect.objectContaining({ metric: 'bsr', observedOn: '2026-10-16', value: 8800 }),
    ])
  })

  it('月销量历史记为 sales_estimate_monthly 估算值；快照取 monthlySold', () => {
    const day1 = Date.UTC(2026, 9, 16, 1) / 60_000 - 21_564_000
    const history = normalizeKeepa(
      payload(
        { kind: 'rank-history', marketplace: 'amazon-us', scope: { ids: ['B0'] } },
        { products: [{ asin: 'B0', monthlySoldHistory: [day1, 300, day1 + 1440, -1] }] },
      ),
    )
    expect(history.observations).toEqual([
      expect.objectContaining({
        metric: 'sales_estimate_monthly',
        observedOn: '2026-10-16',
        value: 300,
        method: 'estimate',
      }),
    ])
    const snapshot = normalizeKeepa(
      payload(
        { kind: 'product-snapshot', marketplace: 'amazon-us', scope: { ids: ['B0'] } },
        { products: [{ asin: 'B0', monthlySold: 200 }] },
      ),
    )
    expect(snapshot.observations).toEqual([
      expect.objectContaining({ metric: 'sales_estimate_monthly', value: 200 }),
    ])
  })

  it('卖家店铺商品列表', () => {
    const batch = normalizeKeepa(
      payload(
        { kind: 'seller-new-listings', marketplace: 'amazon-us', scope: { sellerId: 'A1' } },
        { sellers: { A1: { sellerName: 'Shop', asinList: ['B01', 'B02'] } } },
      ),
    )
    expect(
      batch.entities.filter((e) => e.key.type === 'product').map((e) => e.key.platformId),
    ).toEqual(['B01', 'B02'])
    expect(batch.observations[0]).toMatchObject({ metric: 'listing_count', value: 2 })
  })

  it('offers 只对线索商品开启：令牌估算不同', () => {
    const keepa = createKeepaConnector()
    expect(
      keepa.plan({
        kind: 'product-snapshot',
        marketplace: 'amazon-us',
        scope: { ids: ['a', 'b'] },
      }),
    ).toBe(2)
    expect(
      keepa.plan({
        kind: 'product-snapshot',
        marketplace: 'amazon-us',
        scope: { ids: ['a', 'b'], offers: true },
      }),
    ).toBe(14)
  })
})

describe('DataForSEO（文档样例）', () => {
  it('Trends：每个关键词每周一条，缺失周跳过', () => {
    const body = {
      status_code: 20000,
      cost: 0.009,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              keywords: ['back to school', 'lunch box'],
              items: [
                {
                  type: 'google_trends_graph',
                  keywords: ['back to school', 'lunch box'],
                  data: [
                    { date_from: '2026-07-26', values: [100, 40], missing_data: false },
                    { date_from: '2026-08-02', values: [null, 35], missing_data: false },
                    { date_from: '2026-08-09', values: [80, 30], missing_data: true },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const batch = normalizeDataForSeo(
      payload({ kind: 'search-trend', marketplace: 'global', scope: {} }, body),
    )
    expect(batch.observations.map((o) => [o.entity.platformId, o.observedOn, o.value])).toEqual([
      ['back to school', '2026-07-26', 100],
      ['lunch box', '2026-07-26', 40],
      ['lunch box', '2026-08-02', 35],
    ])
  })

  it('搜索量：月度历史，日期为当月 1 日', () => {
    const body = {
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              keyword: 'Lunch Box',
              search_volume: 90500,
              monthly_searches: [
                { year: 2026, month: 9, search_volume: 110000 },
                { year: 2026, month: 8, search_volume: null },
              ],
            },
          ],
        },
      ],
    }
    const batch = normalizeDataForSeo(
      payload({ kind: 'keyword-volume', marketplace: 'global', scope: {} }, body),
    )
    expect(batch.entities[0]?.key.platformId).toBe('lunch box')
    expect(batch.observations).toEqual([
      expect.objectContaining({
        metric: 'search_volume_monthly',
        observedOn: '2026-09-01',
        value: 110000,
      }),
    ])
  })
})

describe('注册集', () => {
  it('ID 唯一，eBay 额度为 5000/4500', () => {
    const connectors = createConnectors()
    expect(new Set(connectors.map((c) => c.id)).size).toBe(connectors.length)
    expect(connectors.find((c) => c.id === 'ebay-browse')?.budget.hardCap).toBe(5000)
  })
})
