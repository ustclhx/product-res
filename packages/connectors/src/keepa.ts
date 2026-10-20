import {
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type Marketplace,
  type NormalizedBatch,
  type NormalizedObservation,
  parseJson,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'

/**
 * Keepa 连接器（add-source-connectors design D4），依据官方 API 文档：
 * - 令牌桶：每分钟补充；响应带 tokensLeft / refillIn，令牌不足返回 429，按可重试处理（等待补充）
 * - csv 数组：[keepa 时间, 值, ...]，价格单位为分，-1 表示无数据
 * - keepa 时间 = 自 2011-01-01 起的分钟数
 * BSR 原样保存，不在连接器内换算销量。
 * 价格、BSR、评论等是 Keepa 抓取的 Amazon 页面展示值，层级记 T2（add-accuracy-store-tracking D1）。
 */
const API = 'https://api.keepa.com'
const DOMAIN: Partial<Record<Marketplace, number>> = {
  'amazon-us': 1,
  'amazon-uk': 2,
  'amazon-de': 3,
  'amazon-jp': 5,
  'amazon-ca': 6,
}
/** Keepa csv 下标（官方 CsvType） */
const CSV = { AMAZON: 0, NEW: 1, SALES: 3, COUNT_NEW: 11, RATING: 16, COUNT_REVIEWS: 17 } as const

export const keepaTimeToDate = (minutes: number) => new Date((minutes + 21_564_000) * 60_000)

interface KeepaProduct {
  asin?: string
  title?: string
  brand?: string
  manufacturer?: string
  rootCategory?: number
  imagesCSV?: string
  upcList?: string[]
  eanList?: string[]
  listedSince?: number
  csv?: (number[] | null)[]
  stats?: { current?: number[] }
  /** 商品页“过去一个月购买”数（Amazon 展示值，下限估计）；-1 / 缺省表示无 */
  monthlySold?: number
  /** history=1 时：[keepa 时间, monthlySold, ...] */
  monthlySoldHistory?: number[]
}

interface KeepaResponse {
  tokensLeft?: number
  refillIn?: number
  products?: KeepaProduct[]
  sellers?: Record<
    string,
    { sellerName?: string; asinList?: string[]; totalStorefrontAsins?: number[] }
  >
  error?: { type?: string; message?: string }
}

export function createKeepaConnector(): SourceConnector {
  async function call(
    ctx: ConnectorContext,
    task: FetchTask,
    path: string,
    params: URLSearchParams,
  ) {
    const key = ctx.secret('KEEPA_API_KEY')
    if (!key) throw new ConnectorError('auth', 'KEEPA_KEY_MISSING')
    params.set('key', key)
    const res = await httpRequest(
      ctx.fetch,
      { url: `${API}${path}?${params}`, maxBytes: 32 * 1024 * 1024, timeoutMs: 60_000 },
      (status) =>
        status === 402 ? new ConnectorError('quota', 'KEEPA_PAYMENT_REQUIRED', { status }) : null,
    )
    const body = parseJson<KeepaResponse>(res.body)
    const payload: RawPayload = {
      sourceId: 'keepa',
      task,
      request: res.request,
      status: res.status,
      body: res.body,
      fetchedAt: ctx.now().toISOString(),
      ...(body.tokensLeft === undefined ? {} : { remainingQuota: body.tokensLeft }),
    }
    return payload
  }

  const domainOf = (task: FetchTask) => {
    const domain = DOMAIN[task.marketplace]
    if (!domain) throw new ConnectorError('permanent', 'KEEPA_MARKETPLACE_UNSUPPORTED')
    return String(domain)
  }

  return {
    id: 'keepa',
    label: 'Keepa',
    access: 'api',
    marketplaces: ['amazon-us', 'amazon-uk', 'amazon-de', 'amazon-jp', 'amazon-ca'],
    capabilities: ['product-snapshot', 'rank-history', 'seller-new-listings'],
    // 按套餐每分钟令牌数配置；默认按最低档 20 令牌/分钟，团队可按合同调整
    budget: {
      unit: 'token',
      period: 'minute',
      hardCap: 20,
      safetyLine: 20,
      timeZone: 'UTC',
      hardCapEditable: true,
    },
    secrets: ['KEEPA_API_KEY'],
    queue: { concurrency: 1, rateLimit: { limit: 1, periodMs: 3000 } },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      if (!ctx.secret('KEEPA_API_KEY'))
        return { sourceId: 'keepa', checkedAt, credentials: 'missing', checks: [] }
      try {
        const payload = await call(
          ctx,
          { kind: 'product-snapshot', marketplace: 'amazon-us', scope: {} },
          '/token',
          new URLSearchParams(),
        )
        const body = parseJson<KeepaResponse>(payload.body)
        return {
          sourceId: 'keepa',
          checkedAt,
          credentials: 'valid',
          checks: [
            {
              name: 'tokensLeft',
              ok: body.tokensLeft !== undefined,
              detail: String(body.tokensLeft ?? ''),
            },
          ],
        }
      } catch (error) {
        const auth = error instanceof ConnectorError && error.kind === 'auth'
        return {
          sourceId: 'keepa',
          checkedAt,
          credentials: auth ? 'invalid' : 'valid',
          checks: [
            {
              name: 'request',
              ok: false,
              detail: error instanceof ConnectorError ? error.code : 'ERROR',
            },
          ],
        }
      }
    },
    plan(task) {
      if (task.kind === 'seller-new-listings') return 10
      const ids = Array.isArray(task.scope.ids) ? task.scope.ids.length : 0
      // 每个商品 1 令牌；附加 offers 每页约 6 令牌（只对线索商品开启）
      return ids * (task.scope.offers ? 7 : 1)
    },
    async fetch(task, ctx) {
      if (task.kind === 'seller-new-listings') {
        const seller = String(task.scope.sellerId ?? '')
        if (!seller) throw new ConnectorError('permanent', 'KEEPA_SELLER_REQUIRED')
        const params = new URLSearchParams({ domain: domainOf(task), seller, storefront: '1' })
        return { payloads: [await call(ctx, task, '/seller', params)] }
      }
      const ids = Array.isArray(task.scope.ids) ? task.scope.ids.map(String) : []
      if (ids.length === 0 || ids.length > 100)
        throw new ConnectorError('permanent', 'KEEPA_IDS_1_TO_100')
      const params = new URLSearchParams({
        domain: domainOf(task),
        asin: ids.join(','),
        stats: '90',
      })
      if (task.kind === 'rank-history') params.set('history', '1')
      else params.set('history', '0')
      if (task.scope.offers) params.set('offers', '20')
      return { payloads: [await call(ctx, task, '/product', params)] }
    },
    normalize: normalizeKeepa,
  }
}

const cents = (v: number | undefined) => (v === undefined || v < 0 ? undefined : v / 100)
const plain = (v: number | undefined) => (v === undefined || v < 0 ? undefined : v)
const rating = (v: number | undefined) => (v === undefined || v < 0 ? undefined : v / 10)

const SERIES: {
  index: number
  metric: string
  convert: (v: number | undefined) => number | undefined
  currency?: boolean
}[] = [
  { index: CSV.NEW, metric: 'price', convert: cents, currency: true },
  { index: CSV.SALES, metric: 'bsr', convert: plain },
  { index: CSV.COUNT_NEW, metric: 'seller_count', convert: plain },
  { index: CSV.RATING, metric: 'rating', convert: rating },
  { index: CSV.COUNT_REVIEWS, metric: 'review_count', convert: plain },
]

const CURRENCY: Partial<Record<Marketplace, string>> = {
  'amazon-us': 'USD',
  'amazon-uk': 'GBP',
  'amazon-de': 'EUR',
  'amazon-jp': 'JPY',
  'amazon-ca': 'CAD',
}

/** 纯函数：Keepa product / seller 响应 → 实体与观测值 */
export function normalizeKeepa(payload: RawPayload): NormalizedBatch {
  const body = parseJson<KeepaResponse>(payload.body)
  const marketplace = payload.task.marketplace
  const currency = CURRENCY[marketplace]
  const observedOn = payload.fetchedAt.slice(0, 10)
  const entities: NormalizedBatch['entities'][number][] = []
  const observations: NormalizedObservation[] = []
  if (body.sellers) {
    for (const [sellerId, seller] of Object.entries(body.sellers)) {
      const sellerKey = { type: 'seller' as const, marketplace, platformId: sellerId }
      entities.push({ key: sellerKey })
      for (const asin of seller.asinList ?? [])
        entities.push({
          key: { type: 'product', marketplace, platformId: asin },
          facts: { sellerId },
        })
      if (seller.asinList)
        observations.push({
          entity: sellerKey,
          metric: 'listing_count',
          observedOn,
          value: seller.asinList.length,
          method: 'official',
        })
    }
    return { entities, observations }
  }
  const history = payload.task.kind === 'rank-history'
  for (const product of body.products ?? []) {
    if (!product.asin) continue
    const entity = { type: 'product' as const, marketplace, platformId: product.asin }
    entities.push({
      key: entity,
      facts: {
        title: product.title,
        brand: product.brand ?? product.manufacturer,
        gtin: product.upcList?.[0] ?? product.eanList?.[0],
        categoryId: product.rootCategory === undefined ? undefined : String(product.rootCategory),
        imageUrl: product.imagesCSV
          ? `https://m.media-amazon.com/images/I/${product.imagesCSV.split(',')[0]}`
          : undefined,
        listedAt:
          product.listedSince && product.listedSince > 0
            ? keepaTimeToDate(product.listedSince).toISOString()
            : undefined,
      },
    })
    for (const series of SERIES) {
      if (history) {
        // 历史：每天取当天最后一个点
        const csv = product.csv?.[series.index]
        if (!csv) continue
        const daily = new Map<string, number>()
        for (let i = 0; i + 1 < csv.length; i += 2) {
          const value = series.convert(csv[i + 1])
          if (value === undefined) continue
          daily.set(
            keepaTimeToDate(csv[i] as number)
              .toISOString()
              .slice(0, 10),
            value,
          )
        }
        for (const [day, value] of daily)
          observations.push({
            entity,
            metric: series.metric,
            observedOn: day,
            value,
            ...(series.currency && currency ? { currency } : {}),
            method: 'official',
            tier: 2,
          })
      } else {
        const value = series.convert(product.stats?.current?.[series.index])
        if (value === undefined) continue
        observations.push({
          entity,
          metric: series.metric,
          observedOn,
          value,
          ...(series.currency && currency ? { currency } : {}),
          method: 'official',
          tier: 2,
        })
      }
    }
    // 月销量：Amazon 展示的“过去一个月购买”数，属第三方估算口径，供 Keepa 历史回放打标签
    if (history) {
      const csv = product.monthlySoldHistory ?? []
      const daily = new Map<string, number>()
      for (let i = 0; i + 1 < csv.length; i += 2) {
        const value = plain(csv[i + 1])
        if (value === undefined) continue
        daily.set(
          keepaTimeToDate(csv[i] as number)
            .toISOString()
            .slice(0, 10),
          value,
        )
      }
      for (const [day, value] of daily)
        observations.push({
          entity,
          metric: 'sales_estimate_monthly',
          observedOn: day,
          value,
          method: 'estimate',
        })
    } else {
      const value = plain(product.monthlySold)
      if (value !== undefined)
        observations.push({
          entity,
          metric: 'sales_estimate_monthly',
          observedOn,
          value,
          method: 'estimate',
        })
    }
  }
  return { entities, observations }
}
