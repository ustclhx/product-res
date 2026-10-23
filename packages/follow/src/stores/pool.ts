import {
  type Database,
  direction,
  scoped,
  type TRACKED_STORE_KINDS,
  type TRACKED_STORE_STATUSES,
  type TrackedStore,
  trackedStore,
} from '@product-res/db'
import { normalizePhrase } from '@product-res/marketdata'
import { AppError } from '@product-res/shared'
import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm'
import { parseStoreLink, STORE_LINK_ERRORS } from './links.ts'

/**
 * 店铺池（design D4，specs/store-tracking「店铺池」）：空间级配置，只经 scoped() 访问。
 * 与选品方向的对标店铺（direction_seller）并存，不迁移旧数据；方向读取时合并两处（mergedBenchmarks）。
 * 移除只改状态为 removed，保留历史与已发现的新品。
 */

export type TrackedStoreKind = (typeof TRACKED_STORE_KINDS)[number]
export type TrackedStoreStatus = (typeof TRACKED_STORE_STATUSES)[number]

/** Amazon 店铺的发现搜索词 1–5 个；eBay 店铺可选，作为无类目时的 Browse 搜索词 */
export const MAX_STORE_KEYWORDS = 5

export interface StoreSettingsInput {
  readonly kind: TrackedStoreKind
  readonly directionIds?: readonly string[] | undefined
  readonly keywords?: readonly string[] | undefined
  readonly displayName?: string | null | undefined
  readonly reason?: string | null | undefined
}

export interface AddStoreInput extends StoreSettingsInput {
  readonly url: string
}

function cleanKeywords(keywords: readonly string[] | undefined) {
  const out = [...new Set((keywords ?? []).map(normalizePhrase).filter(Boolean))]
  if (out.length > MAX_STORE_KEYWORDS)
    throw new AppError('STORE_KEYWORDS_LIMIT', `每个店铺最多 ${MAX_STORE_KEYWORDS} 个搜索词`, {
      status: 400,
    })
  return out
}

const text = (value: string | null | undefined) => value?.trim() || null

/** 关联方向必须属于本空间；不存在的 ID 视为 NOT_FOUND，不泄露其他空间 */
async function checkDirections(db: Database, workspaceId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const rows = await scoped(db, workspaceId).select(direction, {
    fields: { id: direction.id },
    where: inArray(direction.id, unique),
  })
  if (rows.length !== unique.length)
    throw new AppError('NOT_FOUND', '关联的选品方向不存在', { status: 404 })
  return unique
}

/**
 * eBay 店铺名 → 卖家用户名；返回 null 表示无法确认（由 web 注入 connectors 的店铺页解析）。
 * follow 不直接发外部请求，调用方负责固定站点与超时。
 */
export type EbayStoreResolver = (storeName: string) => Promise<string | null>

export const STORE_USERNAME_UNRESOLVED =
  '无法从 eBay 店铺页确认卖家用户名，请改为粘贴 ebay.com/usr/<用户名> 链接'

/**
 * `/str/<店铺名>` 常与卖家用户名不同，而 Browse 只按用户名过滤（实测修正 2026-10-23）：
 * 解析成功时改存 `/usr/<用户名>`、显示名默认保留店铺名；失败时拒绝添加，不猜测。
 */
async function resolveStoreLink(input: AddStoreInput, resolveEbayStore?: EbayStoreResolver) {
  const parsed = parseStoreLink(input.url)
  if (!parsed.ok)
    throw new AppError('STORE_LINK_UNRECOGNIZED', STORE_LINK_ERRORS[parsed.reason], {
      status: 400,
      details: { reason: parsed.reason },
    })
  if (parsed.form !== 'ebay-store') return { parsed, storeName: null }
  const username = resolveEbayStore ? await resolveEbayStore(parsed.sellerKey) : null
  if (!username)
    throw new AppError('STORE_USERNAME_UNRESOLVED', STORE_USERNAME_UNRESOLVED, {
      status: 422,
      details: { storeName: parsed.sellerKey },
    })
  const user = parseStoreLink(`https://www.ebay.com/usr/${encodeURIComponent(username)}`)
  if (!user.ok)
    throw new AppError('STORE_USERNAME_UNRESOLVED', STORE_USERNAME_UNRESOLVED, { status: 422 })
  return { parsed: user, storeName: parsed.sellerKey }
}

/** 粘贴链接加入店铺池；已移除的同一店铺重新启用并更新设置，追踪中的重复添加返回 409 */
export async function addStore(
  db: Database,
  workspaceId: string,
  input: AddStoreInput,
  options: { readonly resolveEbayStore?: EbayStoreResolver } = {},
) {
  const { parsed, storeName } = await resolveStoreLink(input, options.resolveEbayStore)
  const directionIds = await checkDirections(db, workspaceId, input.directionIds ?? [])
  const keywords = cleanKeywords(input.keywords)
  const s = scoped(db, workspaceId)
  const values = {
    kind: input.kind,
    directionIds,
    keywords,
    displayName: text(input.displayName) ?? storeName ?? parsed.sellerKey,
    reason: text(input.reason),
    url: parsed.url,
  }
  const [existing] = await s.select(trackedStore, {
    where: and(
      eq(trackedStore.marketplace, parsed.marketplace),
      eq(trackedStore.sellerKey, parsed.sellerKey),
    ) as SQL,
  })
  if (existing) {
    if (existing.status !== 'removed')
      throw new AppError('STORE_EXISTS', '该店铺已在店铺池中', {
        status: 409,
        details: { id: existing.id },
      })
    const row = await s.updateById(trackedStore, existing.id, { ...values, status: 'active' })
    return { store: row, parsed, reactivated: true }
  }
  const [row] = await s
    .insert(trackedStore, {
      ...values,
      platform: parsed.platform,
      marketplace: parsed.marketplace,
      sellerKey: parsed.sellerKey,
      status: 'active',
    })
    .returning()
  return { store: row as TrackedStore, parsed, reactivated: false }
}

export async function updateStore(
  db: Database,
  workspaceId: string,
  id: string,
  input: StoreSettingsInput,
) {
  const directionIds = await checkDirections(db, workspaceId, input.directionIds ?? [])
  const s = scoped(db, workspaceId)
  const current = await s.findById(trackedStore, id)
  return s.updateById(trackedStore, id, {
    kind: input.kind,
    directionIds,
    keywords: cleanKeywords(input.keywords),
    displayName: text(input.displayName) ?? current.sellerKey,
    reason: text(input.reason),
  })
}

/** 追踪中 / 暂停 / 已移除；移除保留历史 */
export async function setStoreStatus(
  db: Database,
  workspaceId: string,
  id: string,
  status: TrackedStoreStatus,
) {
  return scoped(db, workspaceId).updateById(trackedStore, id, { status })
}

export async function listStores(
  db: Database,
  workspaceId: string,
  options: { readonly includeRemoved?: boolean } = {},
) {
  return scoped(db, workspaceId)
    .select(trackedStore, {
      ...(options.includeRemoved ? {} : { where: ne(trackedStore.status, 'removed') }),
    })
    .orderBy(asc(trackedStore.createdAt))
}

export async function getStore(db: Database, workspaceId: string, id: string) {
  return scoped(db, workspaceId).findById(trackedStore, id)
}

/**
 * 店铺池中关联到方向的追踪中店铺，按方向分组（站点 × 卖家 ID）。
 * 流水线的对标店铺 = direction_seller（种子 / 已接受）∪ 这里的结果，读取时合并、不迁移。
 */
export async function mergedBenchmarks(
  db: Database,
  workspaceId: string,
): Promise<Map<string, { marketplace: string; sellerId: string }[]>> {
  const rows = await scoped(db, workspaceId).select(trackedStore, {
    fields: {
      marketplace: trackedStore.marketplace,
      sellerKey: trackedStore.sellerKey,
      directionIds: trackedStore.directionIds,
    },
    where: eq(trackedStore.status, 'active'),
  })
  const out = new Map<string, { marketplace: string; sellerId: string }[]>()
  for (const row of rows)
    for (const directionId of row.directionIds) {
      const list = out.get(directionId) ?? []
      list.push({ marketplace: row.marketplace, sellerId: row.sellerKey })
      out.set(directionId, list)
    }
  return out
}

/** 从店铺的关联方向中移除已删除的方向（方向删除时由写入方调用） */
export async function detachDirection(db: Database, workspaceId: string, directionId: string) {
  const s = scoped(db, workspaceId)
  const rows = await s.select(trackedStore)
  for (const row of rows)
    if (row.directionIds.includes(directionId))
      await s.updateById(trackedStore, row.id, {
        directionIds: row.directionIds.filter((id) => id !== directionId),
      })
}
