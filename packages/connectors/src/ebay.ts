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
 * eBay Browse 连接器（add-source-connectors design D2）。依据官方文档实现，字段以 Production 核验为准：
 * - 卖家新品：item_summary/search + filter=sellers:{id} + sort=newlyListed，遇到已见过的商品停止翻页（由调度传 knownIds）
 * - 商品快照：getItems（每批 20 个），返回 estimatedAvailabilities；是否含 estimatedSoldQuantity 待核验
 * 应用令牌（client credentials）在进程内缓存到过期前 5 分钟。
 */
const API = 'https://api.ebay.com'
const SCOPE = 'https://api.ebay.com/oauth/api_scope'
const MARKETPLACE = 'EBAY_US'
const BATCH = 20

interface Token {
  value: string
  expiresAt: number
}

interface EbayAmount {
  value?: string
  currency?: string
}

interface ItemSummary {
  itemId?: string
  legacyItemId?: string
  title?: string
  price?: EbayAmount
  seller?: { username?: string }
  itemCreationDate?: string
  itemWebUrl?: string
  image?: { imageUrl?: string }
  epid?: string
  categories?: { categoryId?: string }[]
}

interface Item extends ItemSummary {
  brand?: string
  gtin?: string
  categoryId?: string
  estimatedAvailabilities?: {
    estimatedAvailableQuantity?: number
    estimatedSoldQuantity?: number
  }[]
  shippingOptions?: { shippingCost?: EbayAmount }[]
}

export function createEbayBrowseConnector(): SourceConnector {
  let token: Token | undefined

  async function accessToken(ctx: ConnectorContext) {
    const now = ctx.now().getTime()
    if (token && token.expiresAt - 5 * 60_000 > now) return token.value
    const id = ctx.secret('EBAY_CLIENT_ID')
    const secret = ctx.secret('EBAY_CLIENT_SECRET')
    if (!id || !secret) throw new ConnectorError('auth', 'EBAY_CREDENTIALS_MISSING')
    const res = await httpRequest(ctx.fetch, {
      method: 'POST',
      url: `${API}/identity/v1/oauth2/token`,
      headers: {
        authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    })
    const body = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
    if (!body.access_token) throw new ConnectorError('auth', 'EBAY_TOKEN_MISSING')
    token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 7200) * 1000 }
    return token.value
  }

  async function get(ctx: ConnectorContext, task: FetchTask, path: string): Promise<RawPayload> {
    const res = await httpRequest(ctx.fetch, {
      url: `${API}${path}`,
      headers: {
        authorization: `Bearer ${await accessToken(ctx)}`,
        'x-ebay-c-marketplace-id': MARKETPLACE,
        accept: 'application/json',
      },
    })
    return {
      sourceId: 'ebay-browse',
      task,
      request: res.request,
      status: res.status,
      body: res.body,
      fetchedAt: ctx.now().toISOString(),
    }
  }

  return {
    id: 'ebay-browse',
    label: 'eBay Browse API',
    access: 'api',
    marketplaces: ['ebay-us'],
    capabilities: ['seller-new-listings', 'product-snapshot'],
    // 每日硬上限 5000、安全线 4500；周期按太平洋时间（以 getRateLimits 的重置时间校准）
    budget: {
      unit: 'call',
      period: 'day',
      hardCap: 5000,
      safetyLine: 4500,
      timeZone: 'America/Los_Angeles',
    },
    secrets: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
    queue: { concurrency: 2, rateLimit: { limit: 5, periodMs: 1000 } },
    async probe(ctx) {
      const checkedAt = ctx.now().toISOString()
      if (!ctx.secret('EBAY_CLIENT_ID') || !ctx.secret('EBAY_CLIENT_SECRET'))
        return { sourceId: 'ebay-browse', checkedAt, credentials: 'missing', checks: [] }
      try {
        // 核验：搜索一个常见词取 3 个商品，再批量查询详情，检查已售量字段
        const task: FetchTask = { kind: 'product-snapshot', marketplace: 'ebay-us', scope: {} }
        const search = parseJson<{ itemSummaries?: ItemSummary[] }>(
          (await get(ctx, task, '/buy/browse/v1/item_summary/search?q=phone%20case&limit=3')).body,
        )
        const ids = (search.itemSummaries ?? []).map((s) => s.itemId).filter(Boolean) as string[]
        const items =
          parseJson<{ items?: Item[] }>(
            (
              await get(
                ctx,
                task,
                `/buy/browse/v1/item/?item_ids=${ids.map(encodeURIComponent).join(',')}`,
              )
            ).body,
          ).items ?? []
        const single = ids[0]
          ? parseJson<Item>(
              (await get(ctx, task, `/buy/browse/v1/item/${encodeURIComponent(ids[0])}`)).body,
            )
          : undefined
        const has = (list: Item[], field: 'estimatedSoldQuantity' | 'estimatedAvailableQuantity') =>
          list.some((i) => i.estimatedAvailabilities?.some((a) => a[field] !== undefined))
        return {
          sourceId: 'ebay-browse',
          checkedAt,
          credentials: 'valid',
          checks: [
            { name: 'search', ok: ids.length > 0 },
            {
              name: 'getItems.estimatedAvailableQuantity',
              ok: has(items, 'estimatedAvailableQuantity'),
            },
            { name: 'getItems.estimatedSoldQuantity', ok: has(items, 'estimatedSoldQuantity') },
            {
              name: 'getItem.estimatedSoldQuantity',
              ok: single ? has([single], 'estimatedSoldQuantity') : false,
            },
          ],
        }
      } catch (error) {
        const code = error instanceof ConnectorError ? error.code : 'ERROR'
        return {
          sourceId: 'ebay-browse',
          checkedAt,
          credentials:
            error instanceof ConnectorError && error.kind === 'auth' ? 'invalid' : 'valid',
          checks: [{ name: 'request', ok: false, detail: code }],
        }
      }
    },
    plan(task) {
      if (task.kind === 'product-snapshot') {
        const ids = idsOf(task)
        return task.scope.mode === 'single' ? ids.length : Math.ceil(ids.length / BATCH)
      }
      return 1
    },
    async fetch(task, ctx) {
      if (task.kind === 'seller-new-listings') {
        const seller = String(task.scope.sellerId ?? '')
        if (!seller) throw new ConnectorError('permanent', 'EBAY_SELLER_REQUIRED')
        const offset = Number(task.cursor ?? 0)
        const query = new URLSearchParams({
          filter: `sellers:{${seller}}`,
          sort: 'newlyListed',
          limit: '200',
          offset: String(offset),
        })
        // Browse 搜索要求 q 或 category_ids；用类目参数（未提供时为根类目以外的常用写法由调度给出）
        if (task.scope.categoryIds) query.set('category_ids', String(task.scope.categoryIds))
        if (task.scope.q) query.set('q', String(task.scope.q))
        return { payloads: [await get(ctx, task, `/buy/browse/v1/item_summary/search?${query}`)] }
      }
      if (task.kind === 'product-snapshot') {
        const ids = idsOf(task)
        if (ids.length === 0) throw new ConnectorError('permanent', 'EBAY_IDS_REQUIRED')
        if (task.scope.mode === 'single') {
          const payloads: RawPayload[] = []
          for (const id of ids)
            payloads.push(await get(ctx, task, `/buy/browse/v1/item/${encodeURIComponent(id)}`))
          return { payloads, cost: ids.length }
        }
        const payloads: RawPayload[] = []
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids
            .slice(i, i + BATCH)
            .map(encodeURIComponent)
            .join(',')
          payloads.push(await get(ctx, task, `/buy/browse/v1/item/?item_ids=${chunk}`))
        }
        return { payloads, cost: payloads.length }
      }
      throw new ConnectorError('permanent', 'EBAY_UNSUPPORTED_KIND')
    },
    normalize: normalizeEbay,
  }
}

const idsOf = (task: FetchTask) => (Array.isArray(task.scope.ids) ? task.scope.ids.map(String) : [])

const money = (amount: EbayAmount | undefined) => {
  const value = Number(amount?.value)
  return Number.isFinite(value) ? value : undefined
}

/** 纯函数：搜索结果 / getItems / getItem 响应 → 实体与观测值 */
export function normalizeEbay(payload: RawPayload): NormalizedBatch {
  const body = parseJson<
    {
      itemSummaries?: ItemSummary[]
      items?: Item[]
      next?: string
      offset?: number
      limit?: number
      total?: number
    } & Item
  >(payload.body)
  const observedOn = payload.fetchedAt.slice(0, 10)
  const list: Item[] = body.itemSummaries ?? body.items ?? (body.itemId ? [body] : [])
  const entities: NormalizedBatch['entities'][number][] = []
  const observations: NormalizedObservation[] = []
  for (const item of list) {
    if (!item.itemId) continue
    const entity = {
      type: 'product' as const,
      marketplace: 'ebay-us' as const,
      platformId: item.itemId,
    }
    entities.push({
      key: entity,
      facts: {
        title: item.title,
        brand: item.brand,
        gtin: item.gtin ?? item.epid,
        categoryId: item.categoryId ?? item.categories?.[0]?.categoryId,
        imageUrl: item.image?.imageUrl,
        url: item.itemWebUrl,
        sellerId: item.seller?.username,
        listedAt: item.itemCreationDate,
      },
    })
    const price = money(item.price)
    if (price !== undefined)
      observations.push({
        entity,
        metric: 'price',
        observedOn,
        value: price,
        currency: item.price?.currency,
        method: 'official',
      })
    const shipping = money(item.shippingOptions?.[0]?.shippingCost)
    if (shipping !== undefined)
      observations.push({
        entity,
        metric: 'shipping_price',
        observedOn,
        value: shipping,
        currency: item.shippingOptions?.[0]?.shippingCost?.currency,
        method: 'official',
      })
    const availability = item.estimatedAvailabilities?.[0]
    if (availability?.estimatedAvailableQuantity !== undefined)
      observations.push({
        entity,
        metric: 'available_quantity',
        observedOn,
        value: availability.estimatedAvailableQuantity,
        method: 'official',
      })
    if (availability?.estimatedSoldQuantity !== undefined)
      observations.push({
        entity,
        metric: 'sold_quantity_total',
        observedOn,
        value: availability.estimatedSoldQuantity,
        method: 'official',
      })
  }
  // 翻页：搜索结果有 next 时给出下一页 offset
  const nextCursor =
    body.itemSummaries && body.next
      ? String((body.offset ?? 0) + (body.limit ?? list.length))
      : undefined
  return { entities, observations, ...(nextCursor ? { nextCursor } : {}) }
}

/**
 * 已售量推算（design D2 回退路径）：官方字段不可得时，用相邻两日可售量的减少近似当日销量。
 * 可售量增加（补货）的日期返回 null（缺失），不计 0 或负数。
 */
export function derivedDailySales(
  previous: number | undefined,
  current: number | undefined,
): number | null {
  if (previous === undefined || current === undefined) return null
  const sold = previous - current
  return sold >= 0 ? sold : null
}

/** 官方累计已售量的日差分；累计值回退（数据修正）时返回 null */
export function dailySalesFromTotals(
  previous: number | undefined,
  current: number | undefined,
): number | null {
  if (previous === undefined || current === undefined) return null
  const sold = current - previous
  return sold >= 0 ? sold : null
}

/**
 * 卖家新品增量翻页：按上新时间倒序遍历，遇到已发现过的商品即停止（specs/connector-ebay「增量翻页」）。
 * 返回本页的新商品 ID，以及是否需要继续翻页。
 */
export function freshListings(batch: NormalizedBatch, known: ReadonlySet<string>) {
  const fresh: string[] = []
  for (const entity of batch.entities) {
    if (known.has(entity.key.platformId)) return { fresh, continue: false }
    fresh.push(entity.key.platformId)
  }
  return { fresh, continue: batch.nextCursor !== undefined }
}
