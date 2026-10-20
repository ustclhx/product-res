import {
  amazonBoughtInterval,
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type NormalizedBatch,
  type NormalizedCategory,
  type NormalizedEntity,
  type NormalizedObservation,
  type NormalizedReview,
  parseBoughtText,
  parseJson,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'
import {
  AMAZON_DOMAIN,
  amazonProductUrl,
  brandFromByline,
  breadcrumbCategories,
  parseAmazonDate,
  productKey,
} from './amazon.ts'

/**
 * SerpApi 连接器（add-accuracy-store-tracking design D3）：`engine=amazon_product` 商品页快照，
 * 用于与 DataForSEO 交叉验证 bought 区间、价格、评论数，并补充结构化 BSR 与页面评论正文。
 * - 预算按月度次数：免费档硬上限 250、安全线 230，日均分配；只有成功调用计数
 * - api_key 放在查询参数中；请求摘要与日志经 http.ts 脱敏，存档的响应体不含密钥
 */
const API = 'https://serpapi.com'
/** 每个任务最多 10 个 ASIN（逐个调用，每个计 1 次） */
const MAX_ASINS_PER_TASK = 10

interface SerpResponse {
  error?: string
  search_metadata?: { status?: string }
  search_parameters?: { asin?: string }
  product_results?: {
    asin?: string
    title?: string
    link_clean?: string
    brand?: string
    thumbnail?: string
    rating?: number | null
    reviews?: number | null
    bought_last_month?: string | null
    extracted_price?: number | null
    categories?: { name?: string; node?: string }[]
  }
  product_details?: {
    brand_name?: string
    manufacturer?: string
    date_first_available?: string
    best_sellers_rank?: { text?: string; extracted_rank?: number | null }[]
  }
  reviews_information?: {
    authors_reviews?: {
      id?: string
      title?: string
      text?: string
      body?: string
      rating?: number | null
      date?: string
      link?: string
    }[]
  }
}

interface SerpAccount {
  error?: string
  plan_searches_left?: number
  total_searches_left?: number
  this_month_usage?: number
}

/**
 * SerpApi 的错误：401 / "Invalid API key" → 凭据失效；"run out of searches" → 额度耗尽；
 * 429 其余情况为限流，可重试。
 */
export function classifySerpApi(status: number, body: string): ConnectorError | null {
  const message = errorMessage(body).toLowerCase()
  if (status === 401 || message.includes('invalid api key'))
    return new ConnectorError('auth', 'SERPAPI_INVALID_KEY', { status })
  if (message.includes('run out of searches'))
    return new ConnectorError('quota', 'SERPAPI_OUT_OF_SEARCHES', { status })
  if (status === 429) return new ConnectorError('retryable', 'SERPAPI_RATE_LIMITED', { status })
  return null
}

/** 响应体顶层的 error 字段；不是 JSON 或没有时为空串 */
function errorMessage(body: string) {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    return typeof parsed?.error === 'string' ? parsed.error : ''
  } catch {
    return ''
  }
}

const asins = (task: FetchTask) => {
  const ids = Array.isArray(task.scope.ids)
    ? task.scope.ids.map(String)
    : task.scope.asin
      ? [String(task.scope.asin)]
      : []
  return ids.filter((id) => id.trim().length > 0)
}

export function createSerpApiConnector(): SourceConnector {
  async function call(ctx: ConnectorContext, path: string, params: URLSearchParams) {
    const key = ctx.secret('SERPAPI_API_KEY')
    if (!key) throw new ConnectorError('auth', 'SERPAPI_KEY_MISSING')
    params.set('api_key', key)
    const res = await httpRequest(
      ctx.fetch,
      { url: `${API}${path}?${params}`, timeoutMs: 60_000 },
      classifySerpApi,
    )
    // 200 也可能带 error（如额度用完、商品不存在）；错误码不含响应正文
    if (errorMessage(res.body))
      throw (
        classifySerpApi(res.status, res.body) ??
        new ConnectorError('permanent', 'SERPAPI_ERROR', { status: res.status })
      )
    return res
  }

  return {
    id: 'serpapi',
    label: 'SerpApi',
    access: 'api',
    marketplaces: ['amazon-us', 'amazon-uk', 'amazon-de', 'amazon-jp', 'amazon-ca'],
    capabilities: ['amazon-product'],
    budget: {
      unit: 'call',
      period: 'month',
      hardCap: 250,
      safetyLine: 230,
      timeZone: 'UTC',
      monthlyAllocation: 'daily-rollover',
      // 付费档（Starter 1000 次 / 月等）按合同调高
      hardCapEditable: true,
    },
    secrets: ['SERPAPI_API_KEY'],
    queue: { concurrency: 1, rateLimit: { limit: 10, periodMs: 60_000 } },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      if (!ctx.secret('SERPAPI_API_KEY'))
        return { sourceId: 'serpapi', checkedAt, credentials: 'missing', checks: [] }
      try {
        // Account API 免费，不计入搜索次数
        const res = await call(ctx, '/account.json', new URLSearchParams())
        const body = parseJson<SerpAccount>(res.body)
        const left = body.total_searches_left ?? body.plan_searches_left
        return {
          sourceId: 'serpapi',
          checkedAt,
          credentials: 'valid',
          checks: [
            {
              name: 'searchesLeft',
              ok: left !== undefined,
              detail: left === undefined ? undefined : String(left),
            },
          ],
        }
      } catch (error) {
        const auth = error instanceof ConnectorError && error.kind === 'auth'
        return {
          sourceId: 'serpapi',
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
    plan: (task) => Math.max(1, asins(task).length),
    async fetch(task, ctx) {
      if (task.kind !== 'amazon-product')
        throw new ConnectorError('permanent', 'SERPAPI_UNSUPPORTED_KIND')
      const domain = AMAZON_DOMAIN[task.marketplace]
      if (!domain) throw new ConnectorError('permanent', 'SERPAPI_MARKETPLACE_UNSUPPORTED')
      const ids = asins(task)
      if (ids.length === 0 || ids.length > MAX_ASINS_PER_TASK)
        throw new ConnectorError('permanent', 'SERPAPI_ASINS_1_TO_10')
      const payloads: RawPayload[] = []
      for (const asin of ids) {
        const res = await call(
          ctx,
          '/search.json',
          new URLSearchParams({ engine: 'amazon_product', asin, amazon_domain: domain }),
        )
        payloads.push({
          sourceId: 'serpapi',
          task,
          request: res.request,
          status: res.status,
          body: res.body,
          fetchedAt: ctx.now().toISOString(),
        })
      }
      return { payloads, cost: payloads.length }
    },
    normalize: normalizeSerpApi,
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 纯函数：amazon_product 响应 → 商品、页面展示值（T2）、类目路径与评论正文；缺失字段不写 */
export function normalizeSerpApi(payload: RawPayload): NormalizedBatch {
  const body = parseJson<SerpResponse>(payload.body)
  const marketplace = payload.task.marketplace
  const product = body.product_results
  const asin = product?.asin?.trim() || body.search_parameters?.asin?.trim()
  if (!product || !asin) return { entities: [], observations: [] }
  const observedOn = payload.fetchedAt.slice(0, 10)
  const entity = productKey(marketplace, asin)
  const details = body.product_details ?? {}
  const crumbs: NormalizedCategory[] = breadcrumbCategories(
    marketplace,
    (product.categories ?? []).map((c) => ({ name: c.name, node: c.node })),
  )
  const firstAvailable = parseAmazonDate(details.date_first_available)
  const entities: NormalizedEntity[] = [
    {
      key: entity,
      facts: {
        title: product.title,
        brand: details.brand_name ?? brandFromByline(product.brand),
        imageUrl: product.thumbnail,
        url: amazonProductUrl(marketplace, asin),
        categoryId: crumbs.at(-1)?.categoryId,
        listedAt: firstAvailable ? `${firstAvailable}T00:00:00.000Z` : undefined,
      },
    },
  ]
  const observations: NormalizedObservation[] = []
  const page = (metric: string, value: number, currency?: string) =>
    observations.push({
      entity,
      metric,
      observedOn,
      value,
      ...(currency ? { currency } : {}),
      method: 'official',
      tier: 2,
    })
  if (isNumber(product.extracted_price))
    page('price', product.extracted_price, currencyOf(marketplace))
  if (isNumber(product.rating)) page('rating', product.rating)
  if (isNumber(product.reviews)) page('review_count', product.reviews)
  const bought = parseBoughtText(product.bought_last_month)
  if (bought !== null)
    observations.push({
      entity,
      metric: 'bought_month',
      observedOn,
      method: 'official',
      tier: 2,
      ...amazonBoughtInterval(bought),
    })
  const [main, sub] = (details.best_sellers_rank ?? []).filter((r) => isNumber(r.extracted_rank))
  if (main) page('bsr', main.extracted_rank as number)
  if (sub) page('bsr_sub', sub.extracted_rank as number)
  const reviews: NormalizedReview[] = []
  for (const review of body.reviews_information?.authors_reviews ?? []) {
    const text = review.text ?? review.body
    if (!text && !review.title) continue
    reviews.push({
      product: entity,
      // 没有平台评论 ID 时用链接或标题 + 日期生成稳定 ID，重复采集不重复写入
      reviewId: review.id ?? review.link ?? `serpapi:${review.title ?? ''}:${review.date ?? ''}`,
      rating: isNumber(review.rating) ? review.rating : undefined,
      title: review.title,
      body: text,
      reviewedOn: parseAmazonDate(review.date?.replace(/^Reviewed in .+? on /i, '')),
    })
  }
  return {
    entities,
    observations,
    categories: crumbs,
    ...(reviews.length > 0 ? { reviews } : {}),
  }
}

const CURRENCY: Partial<Record<FetchTask['marketplace'], string>> = {
  'amazon-us': 'USD',
  'amazon-uk': 'GBP',
  'amazon-de': 'EUR',
  'amazon-jp': 'JPY',
  'amazon-ca': 'CAD',
}
const currencyOf = (marketplace: FetchTask['marketplace']) => CURRENCY[marketplace]
