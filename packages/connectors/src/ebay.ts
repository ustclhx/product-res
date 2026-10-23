import {
  type ConnectorContext,
  ConnectorError,
  type FetchTask,
  httpRequest,
  type NormalizedBatch,
  type NormalizedCategory,
  type NormalizedObservation,
  parseJson,
  type RawPayload,
  type SourceConnector,
} from '@product-res/datasources'
import { EBAY_API, type EbayAppToken, ebayTokenFresh, requestEbayAppToken } from './ebay-token.ts'

/**
 * eBay Browse 连接器（add-source-connectors design D2）。依据官方文档实现，字段以 Production 核验为准：
 * - 卖家新品：item_summary/search + filter=sellers:{id} + sort=newlyListed，遇到已见过的商品停止翻页（由调度传 knownIds）
 * - 商品快照：默认逐个 getItem（返回 estimatedSoldQuantity，官方已售量）。getItems 批量接口需要额外授权，
 *   本应用 Production keyset 调用返回 403 Access denied（2026-10-23 核验，docs/receipts/ebay-browse-2026-10-23.md），
 *   只有显式 `scope.mode === 'batch'` 时才用
 * 应用令牌（client credentials）在进程内缓存到过期前 5 分钟。
 */
const API = EBAY_API
const MARKETPLACE = 'EBAY_US'
const BATCH = 20

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

/** Taxonomy getCategoryTree 的节点（官方文档结构） */
interface CategoryTreeNode {
  category?: { categoryId?: string; categoryName?: string }
  categoryTreeNodeLevel?: number
  leafCategoryTreeNode?: boolean
  childCategoryTreeNodes?: CategoryTreeNode[]
  parentCategoryTreeNodeHref?: string
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
  let token: EbayAppToken | undefined

  async function accessToken(ctx: ConnectorContext) {
    const now = ctx.now().getTime()
    if (ebayTokenFresh(token, now)) return token.value
    token = await requestEbayAppToken(
      ctx.fetch,
      { clientId: ctx.secret('EBAY_CLIENT_ID'), clientSecret: ctx.secret('EBAY_CLIENT_SECRET') },
      now,
    )
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
    capabilities: ['seller-new-listings', 'product-snapshot', 'taxonomy'],
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
        // 核验：搜索一个常见词取 1 个商品，再查单个详情，检查可售量与已售量字段（不调用需额外授权的 getItems）
        const task: FetchTask = { kind: 'product-snapshot', marketplace: 'ebay-us', scope: {} }
        const search = parseJson<{ itemSummaries?: ItemSummary[] }>(
          (await get(ctx, task, '/buy/browse/v1/item_summary/search?q=phone%20case&limit=1')).body,
        )
        const id = (search.itemSummaries ?? []).map((s) => s.itemId).find(Boolean)
        const single = id
          ? parseJson<Item>(
              (await get(ctx, task, `/buy/browse/v1/item/${encodeURIComponent(id)}`)).body,
            )
          : undefined
        const has = (
          item: Item | undefined,
          field: 'estimatedSoldQuantity' | 'estimatedAvailableQuantity',
        ) => item?.estimatedAvailabilities?.some((a) => a[field] !== undefined) ?? false
        return {
          sourceId: 'ebay-browse',
          checkedAt,
          credentials: 'valid',
          checks: [
            { name: 'search', ok: id !== undefined },
            {
              name: 'getItem.estimatedAvailableQuantity',
              ok: has(single, 'estimatedAvailableQuantity'),
            },
            { name: 'getItem.estimatedSoldQuantity', ok: has(single, 'estimatedSoldQuantity') },
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
      // taxonomy：getDefaultCategoryTreeId + getCategoryTree，各计 1 次
      if (task.kind === 'taxonomy') return 2
      if (task.kind === 'product-snapshot') {
        const ids = idsOf(task)
        return task.scope.mode === 'batch' ? Math.ceil(ids.length / BATCH) : ids.length
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
        if (task.scope.mode !== 'batch') {
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
      if (task.kind === 'taxonomy') {
        const idPayload = await get(
          ctx,
          task,
          `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`,
        )
        const treeId = parseJson<{ categoryTreeId?: string }>(idPayload.body).categoryTreeId
        if (!treeId) throw new ConnectorError('invalid-response', 'EBAY_TREE_ID_MISSING')
        const tree = await get(
          ctx,
          task,
          `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}`,
        )
        return { payloads: [idPayload, tree], cost: 2 }
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

/**
 * 纯函数：getCategoryTree 响应 → 类目节点（ID、名称、父 ID、叶子、层级路径）。
 * 根节点只是树的入口，不入库；其子节点的父 ID 为 null。
 */
export function normalizeCategoryTree(body: string): NormalizedCategory[] {
  const tree = parseJson<{
    categoryTreeVersion?: string
    rootCategoryNode?: CategoryTreeNode
  }>(body)
  const treeVersion = tree.categoryTreeVersion ?? ''
  const out: NormalizedCategory[] = []
  const visit = (node: CategoryTreeNode, parent: NormalizedCategory | null) => {
    const id = node.category?.categoryId
    const name = node.category?.categoryName
    let current = parent
    if (id && name) {
      const children = node.childCategoryTreeNodes ?? []
      current = {
        marketplace: 'ebay-us',
        categoryId: id,
        name,
        parentId: parent?.categoryId ?? null,
        leaf: node.leafCategoryTreeNode === true || children.length === 0,
        path: parent ? `${parent.path} > ${name}` : name,
        treeVersion,
      }
      out.push(current)
    }
    for (const child of node.childCategoryTreeNodes ?? []) visit(child, current)
  }
  if (tree.rootCategoryNode) {
    // 根节点（level 0）本身不是可选类目
    for (const child of tree.rootCategoryNode.childCategoryTreeNodes ?? []) visit(child, null)
  }
  return out
}

/** 纯函数：搜索结果 / getItems / getItem / 类目树响应 → 实体与观测值 */
export function normalizeEbay(payload: RawPayload): NormalizedBatch {
  if (payload.task.kind === 'taxonomy') {
    // 默认类目树 ID 响应没有类目，只有 getCategoryTree 的响应带 rootCategoryNode
    return payload.request.url.includes('/category_tree/')
      ? { entities: [], observations: [], categories: normalizeCategoryTree(payload.body) }
      : { entities: [], observations: [] }
  }
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
