import { readFileSync } from 'node:fs'
import type { ConnectorContext, FetchTask, RawPayload } from '@product-res/datasources'
import { describe, expect, it } from 'vitest'
import {
  AISA_DATAFORSEO_API,
  classifySerpApi,
  createConnectors,
  createDataForSeoConnector,
  createSerpApiConnector,
  normalizeDataForSeo,
  normalizeSerpApi,
  parseAmazonDate,
  parseBestSellersRank,
  parseDetailsText,
  resolveDataForSeoTransport,
} from '../src/index.ts'

/**
 * 夹具是 2026-10-20 经 AIsa 实测的 DataForSEO 原始响应体与 SerpApi amazon_product 响应
 * （docs/receipts/aisa-dataforseo-2026-10-20.md），已裁剪并去掉跟踪参数，不含任何凭据。
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const AISA_URL = `${AISA_DATAFORSEO_API}/merchant/amazon/products/live/advanced`
const payload = (
  task: FetchTask,
  body: string,
  url = AISA_URL,
  fetchedAt = '2026-10-20T06:17:34.000Z',
): RawPayload => ({
  sourceId: 'test',
  task,
  request: { method: 'POST', url },
  status: 200,
  body,
  fetchedAt,
})

interface Captured {
  url: string
  headers: Record<string, string>
  body: string | undefined
}

function context(
  secrets: Record<string, string>,
  respond: (url: string) => { status: number; body: string },
  calls: Captured[] = [],
): ConnectorContext {
  return {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body as string | undefined,
      })
      const { status, body } = respond(url)
      return new Response(body, { status })
    }) as unknown as typeof fetch,
    secret: (name) => secrets[name],
    now: () => new Date('2026-10-20T06:17:34.000Z'),
  }
}

const search: FetchTask = {
  kind: 'amazon-search',
  marketplace: 'amazon-us',
  scope: { keyword: 'kids backpack' },
}

describe('DataForSEO 经 AIsa 传输（2.1）', () => {
  it('凭据自动选择：有 AISA_API_KEY 用 aisa，否则用直连，都没有为 null', () => {
    expect(resolveDataForSeoTransport((n) => ({ AISA_API_KEY: 'k' })[n])).toMatchObject({
      kind: 'aisa',
      authorization: 'Bearer k',
    })
    const both = (n: string) =>
      ({ AISA_API_KEY: 'k', DATAFORSEO_LOGIN: 'u', DATAFORSEO_PASSWORD: 'p' })[n]
    expect(resolveDataForSeoTransport(both)?.kind).toBe('aisa')
    expect(resolveDataForSeoTransport(both, 'direct')).toMatchObject({
      kind: 'direct',
      authorization: `Basic ${btoa('u:p')}`,
    })
    expect(resolveDataForSeoTransport(() => undefined)).toBeNull()
    expect(resolveDataForSeoTransport((n) => ({ DATAFORSEO_LOGIN: 'u' })[n])).toBeNull()
  })

  it('aisa：Bearer 认证、网关地址、请求体与直连一致；费用按响应 cost 结算', async () => {
    const calls: Captured[] = []
    const dfs = createDataForSeoConnector()
    const ctx = context(
      { AISA_API_KEY: 'aisa-secret' },
      () => ({ status: 200, body: fixture('dataforseo-amazon-products.json') }),
      calls,
    )
    expect(dfs.plan(search)).toBe(6_000)
    const result = await dfs.fetch(search, ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(AISA_URL)
    expect(calls[0]?.headers.authorization).toBe('Bearer aisa-secret')
    expect(JSON.parse(calls[0]?.body as string)).toEqual([
      { keyword: 'kids backpack', location_code: 2840, language_code: 'en_US' },
    ])
    // 实测 $0.0033 → 3300 微美元
    expect(result.cost).toBe(3_300)
    expect(result.payloads[0]?.request.url).toBe(AISA_URL)
    expect(JSON.stringify(result.payloads[0]?.request)).not.toContain('aisa-secret')
  })

  it('直连：Basic 认证，地址带 /v3，渠道记 direct', async () => {
    const calls: Captured[] = []
    const dfs = createDataForSeoConnector()
    const ctx = context(
      { DATAFORSEO_LOGIN: 'u', DATAFORSEO_PASSWORD: 'p' },
      () => ({ status: 200, body: fixture('dataforseo-amazon-products.json') }),
      calls,
    )
    const result = await dfs.fetch(search, ctx)
    expect(calls[0]?.url).toBe(
      'https://api.dataforseo.com/v3/merchant/amazon/products/live/advanced',
    )
    const batch = dfs.normalize(result.payloads[0] as RawPayload)
    expect(new Set(batch.observations.map((o) => o.channel))).toEqual(new Set(['direct']))
  })

  it.each([
    [402, 'quota', 'AISA_402_BALANCE'],
    [401, 'auth', 'AISA_401_UNAUTHORIZED'],
    [429, 'retryable', 'AISA_429_RATE_LIMITED'],
  ] as const)('AIsa HTTP %i 分类为 %s', async (status, kind, code) => {
    const dfs = createDataForSeoConnector()
    const error = await dfs
      .fetch(
        search,
        context({ AISA_API_KEY: 'k' }, () => ({ status, body: '{}' })),
      )
      .catch((e) => e)
    expect(error).toMatchObject({ kind, code })
    expect(error.stopsSource).toBe(kind !== 'retryable')
  })

  it('没有任何凭据时不发请求', async () => {
    const calls: Captured[] = []
    const error = await createDataForSeoConnector()
      .fetch(
        search,
        context({}, () => ({ status: 200, body: '{}' }), calls),
      )
      .catch((e) => e)
    expect(error).toMatchObject({ kind: 'auth', code: 'DFS_CREDENTIALS_MISSING' })
    expect(calls).toHaveLength(0)
  })

  it('凭据组合：AIsa 或直连任一组齐全即算已配置', () => {
    const dfs = createDataForSeoConnector()
    expect(dfs.credentialSets).toEqual([
      ['AISA_API_KEY'],
      ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    ])
  })
})

describe('DataForSEO 经 AIsa 探测', () => {
  it('查询 AIsa 钱包余额（免费），不调用 AIsa 目录中不存在的 appendix/user_data', async () => {
    const calls: Captured[] = []
    const ctx = context(
      { AISA_API_KEY: 'aisa-secret' },
      () => ({ status: 200, body: JSON.stringify({ available_balance_micros_usd: 49_988_400 }) }),
      calls,
    )
    const receipt = await createDataForSeoConnector().probe(ctx)
    expect(calls.map((c) => c.url)).toEqual(['https://api.aisa.one/v1/credits/balance'])
    expect(calls[0]?.headers.authorization).toBe('Bearer aisa-secret')
    expect(receipt.credentials).toBe('valid')
    expect(receipt.checks).toContainEqual({ name: 'balance', ok: true, detail: '$49.99' })
    expect(JSON.stringify(receipt)).not.toContain('aisa-secret')
  })

  it('余额接口 401 判为凭据失效', async () => {
    const receipt = await createDataForSeoConnector().probe(
      context({ AISA_API_KEY: 'k' }, () => ({ status: 401, body: '{}' })),
    )
    expect(receipt.credentials).toBe('invalid')
  })
})

describe('DataForSEO Amazon 归一化（2.2，真实响应夹具）', () => {
  it('搜索结果：每个 ASIN 的价格、评分、评论数、标识与 bought 区间，层级 T2、渠道 aisa', () => {
    const batch = normalizeDataForSeo(payload(search, fixture('dataforseo-amazon-products.json')))
    const asins = batch.entities.map((e) => e.key.platformId)
    expect(asins).toHaveLength(14)
    expect(new Set(asins).size).toBe(14)
    expect(batch.entities[1]?.facts).toMatchObject({
      url: 'https://www.amazon.com/dp/B0007QCQGI',
    })
    const of = (asin: string) =>
      Object.fromEntries(
        batch.observations.filter((o) => o.entity.platformId === asin).map((o) => [o.metric, o]),
      )
    const jansport = of('B0007QCQGI')
    expect(jansport.price).toMatchObject({
      value: 31.48,
      currency: 'USD',
      tier: 2,
      channel: 'aisa',
    })
    expect(jansport.rating?.value).toBe(4.6)
    expect(jansport.review_count?.value).toBe(45400)
    expect(jansport.is_best_seller?.value).toBe(1)
    expect(jansport.is_amazon_choice?.value).toBe(0)
    expect(jansport.bought_month).toMatchObject({ valueLow: 7000, valueHigh: 8000, tier: 2 })
    expect(jansport.bought_month?.value).toBeCloseTo(Math.sqrt(7000 * 8000))
    expect(of('B0FRM2YBKD').bought_month).toMatchObject({ valueLow: 300, valueHigh: 400 })
    expect(batch.observations.every((o) => o.observedOn === '2026-10-20')).toBe(true)
  })

  it('没有销量徽标的商品不写 bought 观测，其余字段照常写入', () => {
    const batch = normalizeDataForSeo(payload(search, fixture('dataforseo-amazon-products.json')))
    const metrics = batch.observations
      .filter((o) => o.entity.platformId === 'B0H839PB3K')
      .map((o) => o.metric)
    expect(metrics).not.toContain('bought_month')
    expect(metrics).toEqual(
      expect.arrayContaining(['price', 'rating', 'review_count', 'is_best_seller']),
    )
    // 有徽标的约 2/3（实测 84/104），缺失不补零
    const bought = batch.observations.filter((o) => o.metric === 'bought_month')
    expect(bought.length).toBeGreaterThan(0)
    expect(bought.every((o) => (o.valueLow ?? 0) >= 50)).toBe(true)
  })

  it('ASIN 详情：BSR 主类目与子类目、首次上架日期、父体、品牌与类目路径', () => {
    const task: FetchTask = {
      kind: 'amazon-asin',
      marketplace: 'amazon-us',
      scope: { ids: ['B0756FCPPN'] },
    }
    const batch = normalizeDataForSeo(payload(task, fixture('dataforseo-amazon-asin.json')))
    expect(batch.entities).toEqual([
      {
        key: { type: 'product', marketplace: 'amazon-us', platformId: 'B0756FCPPN' },
        facts: expect.objectContaining({
          brand: 'Skechers',
          parentId: 'B07568JYPN',
          listedAt: '2011-11-26T00:00:00.000Z',
          categoryId: '679312011',
          url: 'https://www.amazon.com/dp/B0756FCPPN',
        }),
      },
    ])
    const values = Object.fromEntries(batch.observations.map((o) => [o.metric, o.value]))
    expect(values).toMatchObject({
      price: 46.37,
      rating: 4.6,
      review_count: 38908,
      bsr: 19248,
      bsr_sub: 67,
    })
    // 样本页面没有 bought 徽标：不写
    expect(values).not.toHaveProperty('bought_month')
    expect(batch.categories?.map((c) => c.path).at(-1)).toBe(
      'Clothing, Shoes & Jewelry > Men > Shoes > Fashion Sneakers',
    )
    expect(batch.categories?.[1]).toMatchObject({
      parentId: '7141123011',
      categoryId: '7147441011',
    })
  })

  it('ASIN 详情：没有结构化区块时从 details 文本解析', () => {
    const body = JSON.parse(fixture('dataforseo-amazon-asin.json'))
    const item = body.tasks[0].result[0].items[0]
    item.product_information = null
    const batch = normalizeDataForSeo(
      payload(
        { kind: 'amazon-asin', marketplace: 'amazon-us', scope: { ids: ['B0756FCPPN'] } },
        JSON.stringify(body),
      ),
    )
    const values = Object.fromEntries(batch.observations.map((o) => [o.metric, o.value]))
    expect(values).toMatchObject({ bsr: 19248, bsr_sub: 67 })
    expect(batch.entities[0]?.facts?.listedAt).toBe('2011-11-26T00:00:00.000Z')
  })

  it('卖家报价：报价数、最低价、Buy Box 价与每条报价的卖家归属', () => {
    const task: FetchTask = {
      kind: 'amazon-offers',
      marketplace: 'amazon-us',
      scope: { ids: ['B0756FCPPN'] },
    }
    const batch = normalizeDataForSeo(payload(task, fixture('dataforseo-amazon-sellers.json')))
    const values = Object.fromEntries(batch.observations.map((o) => [o.metric, o.value]))
    expect(values).toEqual({ seller_count: 2, lowest_price: 46.37, buybox_price: 46.37 })
    expect(batch.offers).toEqual([
      expect.objectContaining({
        sellerName: 'Amazon.com',
        sellerId: undefined,
        buyBox: true,
        price: 46.37,
      }),
      expect.objectContaining({
        sellerName: 'Zappos',
        sellerId: 'AH1YFAUS3NHX2',
        shipsFrom: 'Amazon.com',
        buyBox: false,
        price: 63,
      }),
    ])
    expect(batch.entities.map((e) => `${e.key.type}:${e.key.platformId}`)).toEqual([
      'product:B0756FCPPN',
      'seller:AH1YFAUS3NHX2',
    ])
  })

  it('ASIN 详情与报价每个 ASIN 调用一次，预扣按 ASIN 数，结算按实际 cost 之和', async () => {
    const calls: Captured[] = []
    const dfs = createDataForSeoConnector()
    const task: FetchTask = {
      kind: 'amazon-asin',
      marketplace: 'amazon-us',
      scope: { ids: ['B0756FCPPN', 'B0756FCPPN'] },
    }
    expect(dfs.plan(task)).toBe(12_000)
    const result = await dfs.fetch(
      task,
      context(
        { AISA_API_KEY: 'k' },
        () => ({ status: 200, body: fixture('dataforseo-amazon-asin.json') }),
        calls,
      ),
    )
    expect(calls.map((c) => c.url)).toEqual([
      `${AISA_DATAFORSEO_API}/merchant/amazon/asin/live/advanced`,
      `${AISA_DATAFORSEO_API}/merchant/amazon/asin/live/advanced`,
    ])
    expect(result.cost).toBe(10_000)
    await expect(
      dfs.fetch(
        { ...task, scope: { ids: [] } },
        context({ AISA_API_KEY: 'k' }, () => ({ status: 200, body: '{}' })),
      ),
    ).rejects.toMatchObject({ code: 'DFS_ASINS_1_TO_10' })
  })

  it('Labs 站内搜索量：第三方估算 T3，记在当月 1 日（文档结构样例，未实测）', () => {
    const body = {
      cost: 0.1356,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              items: [
                { se_type: 'amazon', keyword: 'Kids Backpack', search_volume: 165000 },
                { se_type: 'amazon', keyword: 'lunch box', search_volume: null },
              ],
            },
          ],
        },
      ],
    }
    const batch = normalizeDataForSeo(
      payload(
        { kind: 'amazon-keyword-volume', marketplace: 'amazon-us', scope: {} },
        JSON.stringify(body),
      ),
    )
    expect(batch.observations).toEqual([
      expect.objectContaining({
        entity: { type: 'keyword', marketplace: 'amazon-us', platformId: 'kids backpack' },
        metric: 'search_volume_monthly',
        observedOn: '2026-10-01',
        value: 165000,
        method: 'estimate',
        tier: 3,
        channel: 'aisa',
      }),
    ])
  })
})

describe('Amazon 页面文本解析', () => {
  it('Best Sellers Rank：主类目与子类目', () => {
    expect(
      parseBestSellersRank(
        "#19,248 in Clothing, Shoes & Jewelry ( See Top 100 in Clothing, Shoes & Jewelry )  #67 in Men's Fashion Sneakers",
      ),
    ).toEqual([
      { rank: 19248, category: 'Clothing, Shoes & Jewelry' },
      { rank: 67, category: "Men's Fashion Sneakers" },
    ])
    expect(parseBestSellersRank('')).toEqual([])
    expect(parseBestSellersRank('not ranked')).toEqual([])
  })

  it.each([
    ['November 26, 2011', '2011-11-26'],
    ['Nov 26, 2011', '2011-11-26'],
    ['26 Nov. 2011', '2011-11-26'],
    ['2011-11-26', '2011-11-26'],
    ['February 30, 2011', undefined],
    ['soon', undefined],
  ])('日期 %s → %s', (text, iso) => {
    expect(parseAmazonDate(text)).toBe(iso)
  })

  it('details 文本：键值与同一行的 Best Sellers Rank', () => {
    const details = parseDetailsText(
      'Product details Product Dimensions\n:\n10 x 15 inches\nDate First Available\n:\nNovember 26, 2011\nBest Sellers Rank:  #5 in Toys  #1 in Puzzles\n',
    )
    expect(details).toMatchObject({
      'Product Dimensions': '10 x 15 inches',
      'Date First Available': 'November 26, 2011',
      'Best Sellers Rank': '#5 in Toys  #1 in Puzzles',
    })
  })
})

describe('SerpApi amazon_product（2.3）', () => {
  const task: FetchTask = {
    kind: 'amazon-product',
    marketplace: 'amazon-us',
    scope: { ids: ['B0007QCQGI'] },
  }

  it('真实响应：价格、评分、评论数、bought 区间（文本解析）与结构化 BSR', () => {
    const batch = normalizeSerpApi(
      payload(task, fixture('serpapi-amazon-product.json'), 'https://serpapi.com/search.json'),
    )
    const values = Object.fromEntries(batch.observations.map((o) => [o.metric, o]))
    expect(values.price).toMatchObject({ value: 31.48, currency: 'USD', tier: 2 })
    expect(values.rating?.value).toBe(4.4)
    expect(values.review_count?.value).toBe(45483)
    expect(values.bsr?.value).toBe(1994)
    expect(values.bsr_sub?.value).toBe(1)
    // "7K+ bought in past month" 与 DataForSEO 的 7000 落在同一区间
    expect(values.bought_month).toMatchObject({ valueLow: 7000, valueHigh: 8000 })
    expect(batch.observations.every((o) => o.channel === undefined)).toBe(true)
    expect(batch.entities[0]?.facts).toMatchObject({
      brand: 'JanSport',
      categoryId: '2404179011',
      url: 'https://www.amazon.com/dp/B0007QCQGI',
    })
    // 本次未返回评论正文
    expect(batch.reviews).toBeUndefined()
  })

  it('缺失字段不写；页面评论正文有则返回', () => {
    const body = JSON.parse(fixture('serpapi-amazon-product.json'))
    delete body.product_results.bought_last_month
    delete body.product_details.best_sellers_rank
    body.reviews_information = {
      authors_reviews: [
        {
          id: 'R1ABC',
          title: 'Zipper broke',
          text: 'Broke after a week.',
          rating: 2,
          date: 'Reviewed in the United States on September 3, 2026',
        },
        { title: '', text: '' },
      ],
    }
    const batch = normalizeSerpApi(payload(task, JSON.stringify(body)))
    const metrics = batch.observations.map((o) => o.metric)
    expect(metrics).not.toContain('bought_month')
    expect(metrics).not.toContain('bsr')
    expect(metrics).toContain('price')
    expect(batch.reviews).toEqual([
      expect.objectContaining({
        reviewId: 'R1ABC',
        rating: 2,
        body: 'Broke after a week.',
        reviewedOn: '2026-09-03',
      }),
    ])
  })

  it('请求摘要与存档不含 api_key；每个 ASIN 计 1 次', async () => {
    const calls: Captured[] = []
    const serp = createSerpApiConnector()
    const result = await serp.fetch(
      task,
      context(
        { SERPAPI_API_KEY: 'serp-secret-key' },
        () => ({ status: 200, body: fixture('serpapi-amazon-product.json') }),
        calls,
      ),
    )
    expect(calls[0]?.url).toContain('api_key=serp-secret-key')
    expect(calls[0]?.url).toContain('engine=amazon_product')
    const archived = JSON.stringify(result.payloads)
    expect(archived).not.toContain('serp-secret-key')
    expect(result.payloads[0]?.request.url).toContain('api_key=%5BREDACTED%5D')
    expect(result.cost).toBe(1)
    expect(serp.plan({ ...task, scope: { ids: ['a', 'b', 'c'] } })).toBe(3)
  })

  it('月度预算：硬上限 250、安全线 230，日均分配', () => {
    expect(createSerpApiConnector().budget).toMatchObject({
      unit: 'call',
      period: 'month',
      hardCap: 250,
      safetyLine: 230,
      monthlyAllocation: 'daily-rollover',
    })
  })

  it.each([
    [200, '{"error":"Your account has run out of searches."}', 'quota'],
    [429, '{"error":"Your account has run out of searches."}', 'quota'],
    [
      401,
      '{"error":"Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}',
      'auth',
    ],
    [429, '{"error":"Too many requests"}', 'retryable'],
    [200, '{"error":"Amazon hasn\'t returned any results for this query."}', 'permanent'],
  ] as const)('HTTP %i %s → %s', async (status, body, kind) => {
    const error = await createSerpApiConnector()
      .fetch(
        task,
        context({ SERPAPI_API_KEY: 'k' }, () => ({ status, body })),
      )
      .catch((e) => e)
    expect(error.kind).toBe(kind)
    expect(String(error.message)).not.toContain('k&')
  })

  it('classifySerpApi 不把正常响应判为错误', () => {
    expect(classifySerpApi(200, fixture('serpapi-amazon-product.json'))).toBeNull()
  })
})

describe('注册集（新数据源）', () => {
  it('包含 SerpApi，DataForSEO 声明 Amazon 能力', () => {
    const connectors = createConnectors()
    const ids = connectors.map((c) => c.id)
    expect(ids).toContain('serpapi')
    expect(connectors.find((c) => c.id === 'dataforseo')?.capabilities).toEqual(
      expect.arrayContaining([
        'amazon-search',
        'amazon-asin',
        'amazon-offers',
        'amazon-keyword-volume',
      ]),
    )
  })
})
