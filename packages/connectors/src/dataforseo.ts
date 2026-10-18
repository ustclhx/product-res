import {
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type NormalizedBatch,
  type NormalizedObservation,
  parseJson,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'

/**
 * DataForSEO 连接器（add-source-connectors design D3），依据官方 v3 文档与旧 pilot 的真实回执：
 * - Google Trends explore：5 年周度曲线（search_trend_index）
 * - Google Ads search volume：关键词月搜索量历史（search_volume_monthly）
 * 预算单位为微美元；实际费用取响应 tasks[].cost。
 */
const API = 'https://api.dataforseo.com'
const LOCATION_US = 2840

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

/** 任务级状态码：20000 成功；40200/40210 余额不足视为额度耗尽；401xx 凭据问题 */
function checkStatus(code: number | undefined) {
  if (code === undefined || code === 20000) return
  if (code === 40200 || code === 40210) throw new ConnectorError('quota', `DFS_${code}`)
  if (code >= 40100 && code < 40200) throw new ConnectorError('auth', `DFS_${code}`)
  if (code >= 50000) throw new ConnectorError('retryable', `DFS_${code}`)
  throw new ConnectorError('permanent', `DFS_${code}`)
}

export function createDataForSeoConnector(): SourceConnector {
  async function post(
    ctx: ConnectorContext,
    task: FetchTask,
    path: string,
    body: unknown,
  ): Promise<RawPayload> {
    const login = ctx.secret('DATAFORSEO_LOGIN')
    const password = ctx.secret('DATAFORSEO_PASSWORD')
    if (!login || !password) throw new ConnectorError('auth', 'DFS_CREDENTIALS_MISSING')
    const res = await httpRequest(ctx.fetch, {
      method: 'POST',
      url: `${API}${path}`,
      headers: {
        authorization: `Basic ${btoa(`${login}:${password}`)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    })
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

  return {
    id: 'dataforseo',
    label: 'DataForSEO',
    access: 'api',
    marketplaces: ['global', 'amazon-us', 'ebay-us'],
    capabilities: ['search-trend', 'keyword-volume'],
    // 微美元 / 月；默认 50 美元硬上限、40 美元安全线，按团队预算调整
    budget: {
      unit: 'usd-micro',
      period: 'month',
      hardCap: 50_000_000,
      safetyLine: 40_000_000,
      timeZone: 'UTC',
      monthlyAllocation: 'first-come',
      hardCapEditable: true,
    },
    secrets: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    queue: { concurrency: 2, rateLimit: { limit: 10, periodMs: 60_000 } },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      if (!ctx.secret('DATAFORSEO_LOGIN') || !ctx.secret('DATAFORSEO_PASSWORD'))
        return { sourceId: 'dataforseo', checkedAt, credentials: 'missing', checks: [] }
      try {
        // 免费接口：账户信息
        const login = ctx.secret('DATAFORSEO_LOGIN') as string
        const password = ctx.secret('DATAFORSEO_PASSWORD') as string
        const res = await httpRequest(ctx.fetch, {
          url: `${API}/v3/appendix/user_data`,
          headers: { authorization: `Basic ${btoa(`${login}:${password}`)}` },
        })
        const body = parseJson<DfsResponse<{ money?: { balance?: number } }>>(res.body)
        checkStatus(body.status_code)
        const balance = body.tasks?.[0]?.result?.[0]?.money?.balance
        return {
          sourceId: 'dataforseo',
          checkedAt,
          credentials: 'valid',
          checks: [
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
      // 保守估算（实际费用以响应 cost 结算）：Trends 每任务约 0.01 美元，搜索量每任务约 0.075 美元
      return task.kind === 'search-trend' ? 10_000 : 75_000
    },
    async fetch(task, ctx) {
      const keywords = Array.isArray(task.scope.keywords) ? task.scope.keywords.map(String) : []
      if (keywords.length === 0) throw new ConnectorError('permanent', 'DFS_KEYWORDS_REQUIRED')
      const location = Number(task.scope.locationCode ?? LOCATION_US)
      let payload: RawPayload
      if (task.kind === 'search-trend') {
        if (keywords.length > 5) throw new ConnectorError('permanent', 'DFS_TRENDS_MAX_5')
        payload = await post(ctx, task, '/v3/keywords_data/google_trends/explore/live', [
          {
            keywords,
            location_code: location,
            language_code: 'en',
            time_range: 'past_5_years',
            type: 'web',
          },
        ])
      } else if (task.kind === 'keyword-volume') {
        if (keywords.length > 1000) throw new ConnectorError('permanent', 'DFS_VOLUME_MAX_1000')
        payload = await post(ctx, task, '/v3/keywords_data/google_ads/search_volume/live', [
          { keywords, location_code: location, language_code: 'en' },
        ])
      } else throw new ConnectorError('permanent', 'DFS_UNSUPPORTED_KIND')
      const cost = parseJson<DfsResponse<unknown>>(payload.body).cost
      return {
        payloads: [payload],
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

/** 纯函数：Trends / 搜索量响应 → 关键词实体与观测值 */
export function normalizeDataForSeo(payload: RawPayload): NormalizedBatch {
  const body = parseJson<DfsResponse<TrendsResult & VolumeResult>>(payload.body)
  const marketplace = payload.task.marketplace
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
          })
        }
      }
    }
  }
  return { entities: [...entities.values()], observations }
}
