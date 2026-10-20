import {
  amazonBoughtInterval,
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type Marketplace,
  type NormalizedBatch,
  type NormalizedCategory,
  type NormalizedEntity,
  type NormalizedObservation,
  type NormalizedOffer,
  parseJson,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'
import {
  amazonProductUrl,
  brandFromByline,
  breadcrumbCategories,
  nodeFromUrl,
  parseAmazonDate,
  parseBestSellersRank,
  parseDetailsText,
  productKey,
  sellerIdFromUrl,
} from './amazon.ts'

/**
 * DataForSEO 连接器（add-source-connectors design D3、add-accuracy-store-tracking design D2）：
 * - Google Trends explore：5 年周度曲线（search_trend_index）
 * - Google Ads search volume：关键词月搜索量历史（search_volume_monthly）
 * - Amazon（Merchant live/advanced）：关键词搜索结果、ASIN 详情、卖家报价；Labs 站内搜索量
 *
 * 传输方式：direct（Basic，api.dataforseo.com）或 aisa（Bearer，AIsa 网关）。请求体与响应体相同，
 * 观测来源仍记 dataforseo，另记渠道（aisa / direct），换回直连时历史数据连续。
 * 预算单位为微美元；实际费用取响应 tasks[].cost（AIsa 按上游 cost × 1.0 收费）。
 */
const DIRECT_API = 'https://api.dataforseo.com/v3'
export const AISA_DATAFORSEO_API = 'https://api.aisa.one/apis/v1/dataforseo'
const LOCATION_US = 2840

export type DataForSeoTransport = 'direct' | 'aisa'

/** Amazon 任务的站点参数；目前只核验了美国站 */
const AMAZON_LOCALE: Partial<
  Record<Marketplace, { location: number; language: string; labsLanguage: string }>
> = {
  'amazon-us': { location: 2840, language: 'en_US', labsLanguage: 'en' },
}

/** 预扣估算（微美元）：Merchant 实测 $0.0033–0.005/次，按 $0.006 预扣；Labs 批量搜索量报价约 $0.136 */
const PLAN = {
  'search-trend': 10_000,
  'keyword-volume': 75_000,
  'amazon-search': 6_000,
  'amazon-asin': 6_000,
  'amazon-offers': 6_000,
  'amazon-keyword-volume': 140_000,
} as const

/** ASIN 详情与报价每个任务最多 10 个 ASIN（live 接口逐个调用） */
const MAX_ASINS_PER_TASK = 10

interface DfsTask<T> {
  status_code?: number
  status_message?: string
  cost?: number
  result?: T[] | null
}
interface DfsResponse<T> {
  status_code?: number
  cost?: number
  tasks?: DfsTask<T>[]
}
interface TrendsResult {
  keywords?: string[]
  items?: {
    type?: string
    keywords?: string[]
    data?: { date_from?: string; values?: (number | null)[]; missing_data?: boolean }[]
  }[]
}
interface VolumeResult {
  keyword?: string
  search_volume?: number | null
  monthly_searches?: { year?: number; month?: number; search_volume?: number | null }[] | null
}

interface DfsRating {
  value?: number | null
  votes_count?: number | null
}
interface DfsAmazonItem {
  type?: string
  title?: string | null
  url?: string | null
  image_url?: string | null
  data_asin?: string | null
  parent_asin?: string | null
  author?: string | null
  price_from?: number | null
  currency?: string | null
  bought_past_month?: number | null
  rating?: DfsRating | null
  is_best_seller?: boolean | null
  is_amazon_choice?: boolean | null
  details?: string | null
  categories?: { category?: string | null; url?: string | null }[] | null
  product_information?:
    | {
        type?: string
        section_name?: string
        body?: Record<string, string> | null
      }[]
    | null
  // 报价
  seller_name?: string | null
  seller_url?: string | null
  ships_from?: string | null
  condition?: string | null
  price?: { current?: number | null; currency?: string | null } | null
  // Labs
  keyword?: string | null
  search_volume?: number | null
}
interface DfsAmazonResult {
  asin?: string | null
  keyword?: string | null
  items?: DfsAmazonItem[] | null
}

/** 任务级状态码：20000 成功；40200/40210 余额不足视为额度耗尽；401xx 凭据问题 */
function checkStatus(code: number | undefined) {
  if (code === undefined || code === 20000) return
  if (code === 40200 || code === 40210) throw new ConnectorError('quota', `DFS_${code}`)
  if (code >= 40100 && code < 40200) throw new ConnectorError('auth', `DFS_${code}`)
  if (code >= 50000) throw new ConnectorError('retryable', `DFS_${code}`)
  throw new ConnectorError('permanent', `DFS_${code}`)
}

/**
 * AIsa 网关的 HTTP 状态（design D2）：402 余额不足 → 额度耗尽（当日停止该来源，不重试）；
 * 401 → 凭据失效；429 → 退避重试。
 */
export function classifyAisaStatus(status: number): ConnectorError | null {
  if (status === 402) return new ConnectorError('quota', 'AISA_402_BALANCE', { status })
  if (status === 401) return new ConnectorError('auth', 'AISA_401_UNAUTHORIZED', { status })
  if (status === 429) return new ConnectorError('retryable', 'AISA_429_RATE_LIMITED', { status })
  return null
}

interface Transport {
  readonly kind: DataForSeoTransport
  readonly base: string
  readonly authorization: string
  readonly classify?: (status: number) => ConnectorError | null
}

/**
 * 凭据自动选择：有 AISA_API_KEY 用 aisa，否则有 DATAFORSEO_LOGIN/PASSWORD 用 direct；
 * 指定了传输方式时只用该方式。都没有时返回 null。
 */
export function resolveDataForSeoTransport(
  secret: ConnectorContext['secret'],
  preferred?: DataForSeoTransport,
): Transport | null {
  const aisaKey = secret('AISA_API_KEY')
  const login = secret('DATAFORSEO_LOGIN')
  const password = secret('DATAFORSEO_PASSWORD')
  if (aisaKey && preferred !== 'direct')
    return {
      kind: 'aisa',
      base: AISA_DATAFORSEO_API,
      authorization: `Bearer ${aisaKey}`,
      classify: classifyAisaStatus,
    }
  if (login && password && preferred !== 'aisa')
    return {
      kind: 'direct',
      base: DIRECT_API,
      authorization: `Basic ${btoa(`${login}:${password}`)}`,
    }
  return null
}

/** 存档请求摘要 → 经由渠道；回放时同样可推出 */
export const dataForSeoChannel = (requestUrl: string): DataForSeoTransport =>
  requestUrl.startsWith(AISA_DATAFORSEO_API) ? 'aisa' : 'direct'

const asins = (task: FetchTask) => {
  const ids = Array.isArray(task.scope.ids)
    ? task.scope.ids.map(String)
    : task.scope.asin
      ? [String(task.scope.asin)]
      : []
  return ids.filter((id) => id.trim().length > 0)
}

export function createDataForSeoConnector(
  options: { readonly transport?: DataForSeoTransport } = {},
): SourceConnector {
  async function post(
    ctx: ConnectorContext,
    task: FetchTask,
    path: string,
    body: unknown,
  ): Promise<RawPayload> {
    const transport = resolveDataForSeoTransport(ctx.secret, options.transport)
    if (!transport) throw new ConnectorError('auth', 'DFS_CREDENTIALS_MISSING')
    const res = await httpRequest(
      ctx.fetch,
      {
        method: 'POST',
        url: `${transport.base}${path}`,
        headers: { authorization: transport.authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      },
      transport.classify,
    )
    const parsed = parseJson<DfsResponse<unknown>>(res.body)
    checkStatus(parsed.status_code)
    for (const t of parsed.tasks ?? []) checkStatus(t.status_code)
    return {
      sourceId: 'dataforseo',
      task,
      request: res.request,
      status: res.status,
      body: res.body,
      fetchedAt: ctx.now().toISOString(),
    }
  }

  const locale = (task: FetchTask) => {
    const value = AMAZON_LOCALE[task.marketplace]
    if (!value) throw new ConnectorError('permanent', 'DFS_MARKETPLACE_UNSUPPORTED')
    return value
  }

  async function fetchPayloads(task: FetchTask, ctx: ConnectorContext): Promise<RawPayload[]> {
    switch (task.kind) {
      case 'search-trend':
      case 'keyword-volume': {
        const keywords = Array.isArray(task.scope.keywords) ? task.scope.keywords.map(String) : []
        if (keywords.length === 0) throw new ConnectorError('permanent', 'DFS_KEYWORDS_REQUIRED')
        const location = Number(task.scope.locationCode ?? LOCATION_US)
        if (task.kind === 'search-trend') {
          if (keywords.length > 5) throw new ConnectorError('permanent', 'DFS_TRENDS_MAX_5')
          return [
            await post(ctx, task, '/keywords_data/google_trends/explore/live', [
              {
                keywords,
                location_code: location,
                language_code: 'en',
                time_range: 'past_5_years',
                type: 'web',
              },
            ]),
          ]
        }
        if (keywords.length > 1000) throw new ConnectorError('permanent', 'DFS_VOLUME_MAX_1000')
        return [
          await post(ctx, task, '/keywords_data/google_ads/search_volume/live', [
            { keywords, location_code: location, language_code: 'en' },
          ]),
        ]
      }
      case 'amazon-search': {
        const keyword = String(task.scope.keyword ?? '').trim()
        if (!keyword) throw new ConnectorError('permanent', 'DFS_KEYWORD_REQUIRED')
        const { location, language } = locale(task)
        // 1 页（默认深度），本期统一用 live：standard 队列在 AIsa 的 HTTP 网关上未核验
        return [
          await post(ctx, task, '/merchant/amazon/products/live/advanced', [
            { keyword, location_code: location, language_code: language },
          ]),
        ]
      }
      case 'amazon-asin':
      case 'amazon-offers': {
        const ids = asins(task)
        if (ids.length === 0 || ids.length > MAX_ASINS_PER_TASK)
          throw new ConnectorError('permanent', 'DFS_ASINS_1_TO_10')
        const { location, language } = locale(task)
        const path =
          task.kind === 'amazon-asin'
            ? '/merchant/amazon/asin/live/advanced'
            : '/merchant/amazon/sellers/live/advanced'
        const payloads: RawPayload[] = []
        for (const asin of ids)
          payloads.push(
            await post(ctx, task, path, [
              { asin, location_code: location, language_code: language },
            ]),
          )
        return payloads
      }
      case 'amazon-keyword-volume': {
        const keywords = Array.isArray(task.scope.keywords) ? task.scope.keywords.map(String) : []
        if (keywords.length === 0) throw new ConnectorError('permanent', 'DFS_KEYWORDS_REQUIRED')
        if (keywords.length > 1000) throw new ConnectorError('permanent', 'DFS_VOLUME_MAX_1000')
        const { location, labsLanguage } = locale(task)
        return [
          await post(ctx, task, '/dataforseo_labs/amazon/bulk_search_volume/live', [
            { keywords, location_code: location, language_code: labsLanguage },
          ]),
        ]
      }
      default:
        throw new ConnectorError('permanent', 'DFS_UNSUPPORTED_KIND')
    }
  }

  return {
    id: 'dataforseo',
    label: 'DataForSEO',
    access: 'api',
    marketplaces: ['global', 'amazon-us', 'ebay-us'],
    capabilities: [
      'search-trend',
      'keyword-volume',
      'amazon-search',
      'amazon-asin',
      'amazon-offers',
      'amazon-keyword-volume',
    ],
    // 微美元 / 月；默认 50 美元硬上限、40 美元安全线，按团队预算调整（AIsa 测试期按 $45 配置）
    budget: {
      unit: 'usd-micro',
      period: 'month',
      hardCap: 50_000_000,
      safetyLine: 40_000_000,
      timeZone: 'UTC',
      monthlyAllocation: 'first-come',
      hardCapEditable: true,
    },
    secrets: ['AISA_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    credentialSets: [['AISA_API_KEY'], ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']],
    queue: { concurrency: 2, rateLimit: { limit: 10, periodMs: 60_000 } },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      const transport = resolveDataForSeoTransport(ctx.secret, options.transport)
      if (!transport)
        return { sourceId: 'dataforseo', checkedAt, credentials: 'missing', checks: [] }
      const channel = { name: 'channel', ok: true, detail: transport.kind }
      try {
        // 免费接口：账户信息（经 AIsa 时上游 cost 为 0）
        const res = await httpRequest(
          ctx.fetch,
          {
            url: `${transport.base}/appendix/user_data`,
            headers: { authorization: transport.authorization },
          },
          transport.classify,
        )
        const body = parseJson<DfsResponse<{ money?: { balance?: number } }>>(res.body)
        checkStatus(body.status_code)
        const balance = body.tasks?.[0]?.result?.[0]?.money?.balance
        return {
          sourceId: 'dataforseo',
          checkedAt,
          credentials: 'valid',
          checks: [
            channel,
            {
              name: 'balance',
              ok: balance !== undefined,
              detail: balance === undefined ? undefined : `$${balance}`,
            },
          ],
        }
      } catch (error) {
        const auth = error instanceof ConnectorError && error.kind === 'auth'
        return {
          sourceId: 'dataforseo',
          checkedAt,
          credentials: auth ? 'invalid' : 'valid',
          checks: [
            channel,
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
      // 保守估算，实际费用以响应 cost 结算
      if (task.kind === 'amazon-asin' || task.kind === 'amazon-offers')
        return PLAN[task.kind] * Math.max(1, asins(task).length)
      return PLAN[task.kind as keyof typeof PLAN] ?? PLAN['keyword-volume']
    },
    async fetch(task, ctx) {
      const payloads = await fetchPayloads(task, ctx)
      let cost: number | undefined
      for (const payload of payloads) {
        const value = parseJson<DfsResponse<unknown>>(payload.body).cost
        if (value !== undefined) cost = (cost ?? 0) + value
      }
      return {
        payloads,
        ...(cost === undefined ? {} : { cost: Math.round(cost * 1_000_000) }),
      }
    },
    normalize: normalizeDataForSeo,
  }
}

const keywordKey = (phrase: string, marketplace: FetchTask['marketplace']) => ({
  type: 'keyword' as const,
  marketplace,
  platformId: phrase.trim().toLowerCase(),
})

/** 纯函数：DataForSEO 响应 → 实体、观测值（以及 Amazon 类目与报价） */
export function normalizeDataForSeo(payload: RawPayload): NormalizedBatch {
  switch (payload.task.kind) {
    case 'amazon-search':
      return normalizeAmazonSearch(payload)
    case 'amazon-asin':
      return normalizeAmazonAsin(payload)
    case 'amazon-offers':
      return normalizeAmazonOffers(payload)
    case 'amazon-keyword-volume':
      return normalizeAmazonKeywordVolume(payload)
    default:
      return normalizeGoogle(payload)
  }
}

function normalizeGoogle(payload: RawPayload): NormalizedBatch {
  const body = parseJson<DfsResponse<TrendsResult & VolumeResult>>(payload.body)
  const marketplace = payload.task.marketplace
  const channel = dataForSeoChannel(payload.request.url)
  const entities = new Map<string, NormalizedBatch['entities'][number]>()
  const observations: NormalizedObservation[] = []
  for (const task of body.tasks ?? []) {
    for (const result of task.result ?? []) {
      if (payload.task.kind === 'search-trend') {
        const graph = result.items?.find((i) => i.type === 'google_trends_graph')
        const words = graph?.keywords ?? result.keywords ?? []
        for (const word of words) entities.set(word, { key: keywordKey(word, marketplace) })
        for (const point of graph?.data ?? []) {
          if (!point.date_from || point.missing_data) continue
          words.forEach((word, i) => {
            const value = point.values?.[i]
            if (value === null || value === undefined) return
            observations.push({
              entity: keywordKey(word, marketplace),
              metric: 'search_trend_index',
              observedOn: point.date_from as string,
              value,
              method: 'official',
              channel,
            })
          })
        }
      } else if (result.keyword) {
        const key = keywordKey(result.keyword, marketplace)
        entities.set(result.keyword, { key })
        for (const month of result.monthly_searches ?? []) {
          if (
            !month.year ||
            !month.month ||
            month.search_volume === null ||
            month.search_volume === undefined
          )
            continue
          observations.push({
            entity: key,
            metric: 'search_volume_monthly',
            observedOn: `${month.year}-${String(month.month).padStart(2, '0')}-01`,
            value: month.search_volume,
            method: 'official',
            channel,
          })
        }
      }
    }
  }
  return { entities: [...entities.values()], observations }
}

/** 全部任务的 result 合并 */
const results = (payload: RawPayload) =>
  (parseJson<DfsResponse<DfsAmazonResult>>(payload.body).tasks ?? []).flatMap((t) => t.result ?? [])

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Amazon 页面展示值：T2，经由渠道 */
function pageObservation(
  base: Pick<NormalizedObservation, 'entity' | 'observedOn' | 'channel'>,
  metric: string,
  value: number,
  currency?: string | null,
): NormalizedObservation {
  return {
    ...base,
    metric,
    value,
    ...(currency ? { currency } : {}),
    method: 'official',
    tier: 2,
  }
}

/** 搜索结果 / 详情共有的价格、评分、评论数、bought 区间、标识；缺失字段不写 */
function itemObservations(
  base: Pick<NormalizedObservation, 'entity' | 'observedOn' | 'channel'>,
  item: DfsAmazonItem,
) {
  const out: NormalizedObservation[] = []
  if (isNumber(item.price_from))
    out.push(pageObservation(base, 'price', item.price_from, item.currency))
  if (isNumber(item.rating?.value)) out.push(pageObservation(base, 'rating', item.rating.value))
  if (isNumber(item.rating?.votes_count))
    out.push(pageObservation(base, 'review_count', item.rating.votes_count))
  if (isNumber(item.bought_past_month) && item.bought_past_month > 0)
    out.push({
      ...pageObservation(base, 'bought_month', 0),
      ...amazonBoughtInterval(item.bought_past_month),
    })
  if (typeof item.is_best_seller === 'boolean')
    out.push(pageObservation(base, 'is_best_seller', item.is_best_seller ? 1 : 0))
  if (typeof item.is_amazon_choice === 'boolean')
    out.push(pageObservation(base, 'is_amazon_choice', item.is_amazon_choice ? 1 : 0))
  return out
}

/** 关键词搜索结果页：自然结果与广告位，同一 ASIN 以先出现（自然结果在前）的为准 */
function normalizeAmazonSearch(payload: RawPayload): NormalizedBatch {
  const marketplace = payload.task.marketplace
  const observedOn = payload.fetchedAt.slice(0, 10)
  const channel = dataForSeoChannel(payload.request.url)
  const entities: NormalizedEntity[] = []
  const observations: NormalizedObservation[] = []
  const seen = new Set<string>()
  const items = results(payload).flatMap((r) => r.items ?? [])
  const ordered = [
    ...items.filter((i) => i.type === 'amazon_serp'),
    ...items.filter((i) => i.type === 'amazon_paid'),
  ]
  for (const item of ordered) {
    const asin = item.data_asin?.trim()
    if (!asin || seen.has(asin)) continue
    seen.add(asin)
    const entity = productKey(marketplace, asin)
    entities.push({
      key: entity,
      facts: {
        title: item.title ?? undefined,
        imageUrl: item.image_url ?? undefined,
        url: amazonProductUrl(marketplace, asin),
      },
    })
    observations.push(...itemObservations({ entity, observedOn, channel }, item))
  }
  return { entities, observations }
}

/** ASIN 详情：价格、评分、评论数、BSR（主类目 / 子类目）、首次上架日期、父体、品牌、类目路径 */
function normalizeAmazonAsin(payload: RawPayload): NormalizedBatch {
  const marketplace = payload.task.marketplace
  const observedOn = payload.fetchedAt.slice(0, 10)
  const channel = dataForSeoChannel(payload.request.url)
  const entities: NormalizedEntity[] = []
  const observations: NormalizedObservation[] = []
  const categories = new Map<string, NormalizedCategory>()
  for (const result of results(payload)) {
    const item = result.items?.find((i) => i.type === 'amazon_product_info')
    const asin = item?.data_asin?.trim() || result.asin?.trim()
    if (!item || !asin) continue
    const entity = productKey(marketplace, asin)
    const details = {
      ...parseDetailsText(item.details),
      ...(item.product_information?.find((s) => s.type === 'product_information_details_item')
        ?.body ?? {}),
    }
    const crumbs = breadcrumbCategories(
      marketplace,
      (item.categories ?? []).map((c) => ({ name: c.category, node: nodeFromUrl(c.url) })),
    )
    for (const node of crumbs) categories.set(node.categoryId, node)
    const firstAvailable = parseAmazonDate(details['Date First Available'])
    entities.push({
      key: entity,
      facts: {
        title: item.title ?? undefined,
        brand: details.Brand ?? details['Brand Name'] ?? brandFromByline(item.author),
        imageUrl: item.image_url ?? undefined,
        url: amazonProductUrl(marketplace, asin),
        categoryId: crumbs.at(-1)?.categoryId,
        listedAt: firstAvailable ? `${firstAvailable}T00:00:00.000Z` : undefined,
        parentId: item.parent_asin ?? undefined,
      },
    })
    const base = { entity, observedOn, channel }
    observations.push(...itemObservations(base, item))
    const [main, sub] = parseBestSellersRank(details['Best Sellers Rank'])
    if (main) observations.push(pageObservation(base, 'bsr', main.rank))
    if (sub) observations.push(pageObservation(base, 'bsr_sub', sub.rank))
  }
  return { entities, observations, categories: [...categories.values()] }
}

/** 卖家报价：报价数、最低价（新品优先）、Buy Box 价与每条报价的卖家 */
function normalizeAmazonOffers(payload: RawPayload): NormalizedBatch {
  const marketplace = payload.task.marketplace
  const observedOn = payload.fetchedAt.slice(0, 10)
  const channel = dataForSeoChannel(payload.request.url)
  const entities: NormalizedEntity[] = []
  const observations: NormalizedObservation[] = []
  const offers: NormalizedOffer[] = []
  const sellers = new Set<string>()
  for (const result of results(payload)) {
    const asin = result.asin?.trim()
    if (!asin) continue
    const entity = productKey(marketplace, asin)
    entities.push({ key: entity })
    const items = (result.items ?? []).filter(
      (i) => i.type === 'amazon_seller_main_item' || i.type === 'amazon_seller_item',
    )
    for (const item of items) {
      const sellerId = sellerIdFromUrl(item.seller_url)
      if (sellerId) sellers.add(sellerId)
      offers.push({
        product: entity,
        sellerId,
        sellerName: item.seller_name ?? undefined,
        shipsFrom: item.ships_from ?? undefined,
        price: isNumber(item.price?.current) ? item.price.current : undefined,
        currency: item.price?.currency ?? undefined,
        condition: item.condition ?? undefined,
        buyBox: item.type === 'amazon_seller_main_item',
      })
    }
    const base = { entity, observedOn, channel }
    const own = offers.filter((o) => o.product === entity)
    if (own.length === 0) continue
    observations.push(pageObservation(base, 'seller_count', own.length))
    const priced = own.filter((o) => o.price !== undefined)
    const fresh = priced.filter((o) => o.condition?.toLowerCase().startsWith('new'))
    const pool = fresh.length > 0 ? fresh : priced
    const lowest = pool.reduce<NormalizedOffer | undefined>(
      (min, o) => (min === undefined || (o.price as number) < (min.price as number) ? o : min),
      undefined,
    )
    if (lowest)
      observations.push(
        pageObservation(base, 'lowest_price', lowest.price as number, lowest.currency),
      )
    const buyBox = own.find((o) => o.buyBox && o.price !== undefined)
    if (buyBox)
      observations.push(
        pageObservation(base, 'buybox_price', buyBox.price as number, buyBox.currency),
      )
  }
  for (const sellerId of sellers)
    entities.push({ key: { type: 'seller', marketplace, platformId: sellerId } })
  return { entities, observations, offers }
}

/** Labs 站内搜索量：第三方估算（T3），记在当月 1 日 */
function normalizeAmazonKeywordVolume(payload: RawPayload): NormalizedBatch {
  const marketplace = payload.task.marketplace
  const observedOn = `${payload.fetchedAt.slice(0, 7)}-01`
  const channel = dataForSeoChannel(payload.request.url)
  const entities = new Map<string, NormalizedEntity>()
  const observations: NormalizedObservation[] = []
  for (const result of results(payload)) {
    for (const item of result.items ?? []) {
      if (!item.keyword || !isNumber(item.search_volume)) continue
      const key = keywordKey(item.keyword, marketplace)
      entities.set(key.platformId, { key })
      observations.push({
        entity: key,
        metric: 'search_volume_monthly',
        observedOn,
        value: item.search_volume,
        method: 'estimate',
        tier: 3,
        channel,
      })
    }
  }
  return { entities: [...entities.values()], observations }
}
