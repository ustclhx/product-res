import {
  cluster,
  type Direction,
  type DirectionSeller,
  direction,
  directionSeller,
  ensureSelectionDefaults,
  scoped,
  seasonalNode,
} from '@product-res/db'
import { searchCategories } from '@product-res/marketdata'
import { AppError } from '@product-res/shared'
import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'
import type { DirectionMarketplace } from './marketplaces.ts'

/**
 * 选品方向与对标店铺池（specs/selection-directions）。读取要求空间成员，写入要求可写空间的
 * owner / admin；所有查询经 scoped()。店铺推荐算法在流水线中生成 suggested 行，本页只做状态流转。
 */

export interface DirectionInput {
  name: string
  marketplaces: DirectionMarketplace[]
  categoryIds: string[]
  keywords: string[]
  nodeIds: string[]
  note?: string | null | undefined
}

export interface DirectionRow {
  id: string
  name: string
  marketplaces: string[]
  categoryIds: string[]
  keywords: string[]
  nodeIds: string[]
  enabled: boolean
  note: string | null
  updatedAt: string
}

export interface SellerRow {
  id: string
  directionId: string
  marketplace: string
  sellerPlatformId: string
  sellerName: string | null
  status: DirectionSeller['status']
  reason: string | null
  updatedAt: string
}

const toDirectionRow = (d: Direction): DirectionRow => ({
  id: d.id,
  name: d.name,
  marketplaces: d.marketplaces,
  categoryIds: d.categoryIds,
  keywords: d.keywords,
  nodeIds: d.nodeIds,
  enabled: d.enabled,
  note: d.note,
  updatedAt: d.updatedAt.toISOString(),
})

/** 推荐依据：流水线写入的 JSON 中优先取 summary 文本 */
function reasonText(reason: Record<string, unknown> | null): string | null {
  if (!reason) return null
  if (typeof reason.summary === 'string') return reason.summary
  return JSON.stringify(reason)
}

const toSellerRow = (s: DirectionSeller): SellerRow => ({
  id: s.id,
  directionId: s.directionId,
  marketplace: s.marketplace,
  sellerPlatformId: s.sellerPlatformId,
  sellerName: s.sellerName,
  status: s.status,
  reason: reasonText(s.reason),
  updatedAt: s.updatedAt.toISOString(),
})

const conflict = (message: string) => new AppError('CONFLICT', message, { status: 409 })

export async function directionsPage(actor: WorkbenchActor) {
  const { db, workspaceId } = actor
  await ensureSelectionDefaults(db, workspaceId)
  const s = scoped(db, workspaceId)
  const [directions, sellers, nodes] = await Promise.all([
    s.select(direction).orderBy(asc(direction.createdAt)),
    s.select(directionSeller).orderBy(asc(directionSeller.createdAt)),
    s
      .select(seasonalNode, { fields: { id: seasonalNode.id, name: seasonalNode.name } })
      .orderBy(asc(seasonalNode.startMonth), asc(seasonalNode.startDay)),
  ])
  return {
    directions: directions.map(toDirectionRow),
    sellers: sellers.map(toSellerRow),
    nodes,
  }
}

/** 按名称或 ID 搜索站点类目（marketplace_category 为部署级共享数据，调用方已通过空间成员校验） */
export function searchCategoryOptions(actor: WorkbenchActor, marketplace: 'ebay-us', q: string) {
  return searchCategories(actor.db, marketplace, q)
}

async function normalize(actor: WorkbenchActor, input: DirectionInput, excludeId?: string) {
  const s = scoped(actor.db, actor.workspaceId)
  const name = input.name.trim()
  const sameName = await s.count(
    direction,
    excludeId
      ? and(eq(direction.name, name), ne(direction.id, excludeId))
      : eq(direction.name, name),
  )
  if (sameName > 0) throw conflict('已有同名方向')
  // 只保留本空间存在的节点，其他空间的节点 id 静默丢弃
  const nodeIds =
    input.nodeIds.length === 0
      ? []
      : (
          await s.select(seasonalNode, {
            where: inArray(seasonalNode.id, input.nodeIds),
            fields: { id: seasonalNode.id },
          })
        ).map((n) => n.id)
  return {
    name,
    marketplaces: [...new Set(input.marketplaces)],
    categoryIds: [...new Set(input.categoryIds)],
    keywords: [...new Set(input.keywords)],
    nodeIds,
    note: input.note?.trim() || null,
  }
}

export async function createDirection(actor: WorkbenchActor, input: DirectionInput) {
  assertWorkbenchWriter(actor)
  const values = await normalize(actor, input)
  const [row] = await scoped(actor.db, actor.workspaceId).insert(direction, values).returning()
  if (!row) throw new Error('insert direction failed')
  return toDirectionRow(row)
}

export async function updateDirection(actor: WorkbenchActor, id: string, input: DirectionInput) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  await s.findById(direction, id)
  const values = await normalize(actor, input, id)
  return toDirectionRow(await s.updateById(direction, id, values))
}

export async function setDirectionEnabled(actor: WorkbenchActor, id: string, enabled: boolean) {
  assertWorkbenchWriter(actor)
  return toDirectionRow(
    await scoped(actor.db, actor.workspaceId).updateById(direction, id, { enabled }),
  )
}

/** 已生成商品簇（及线索）的方向只能停用，避免历史线索失去方向 */
export async function deleteDirection(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  await s.findById(direction, id)
  if ((await s.count(cluster, eq(cluster.directionId, id))) > 0)
    throw conflict('该方向已有商品簇和线索，只能停用')
  await s.deleteById(direction, id)
}

export interface SeedSellerInput {
  directionId: string
  marketplace: DirectionMarketplace
  sellerPlatformId: string
  sellerName?: string | null | undefined
}

/** 手动添加种子店铺；之前被拒绝或待审的同一店铺改为种子 */
export async function addSeedSeller(actor: WorkbenchActor, input: SeedSellerInput) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const dir = await s.findById(direction, input.directionId)
  if (!dir.marketplaces.includes(input.marketplace))
    throw new AppError('INVALID_MARKETPLACE', '该方向没有选择这个平台站点', { status: 400 })
  const sellerPlatformId = input.sellerPlatformId.trim()
  const sellerName = input.sellerName?.trim() || null
  const [existing] = await s.select(directionSeller, {
    where: and(
      eq(directionSeller.directionId, dir.id),
      eq(directionSeller.marketplace, input.marketplace),
      eq(directionSeller.sellerPlatformId, sellerPlatformId),
    ) as SQL,
  })
  if (existing) {
    if (existing.status === 'seed' || existing.status === 'accepted')
      throw conflict('该店铺已在店铺池中')
    return toSellerRow(
      await s.updateById(directionSeller, existing.id, {
        status: 'seed',
        ...(sellerName ? { sellerName } : {}),
      }),
    )
  }
  const [row] = await s
    .insert(directionSeller, {
      directionId: dir.id,
      marketplace: input.marketplace,
      sellerPlatformId,
      sellerName,
      status: 'seed',
    })
    .returning()
  if (!row) throw new Error('insert seller failed')
  return toSellerRow(row)
}

/** 接受或拒绝系统推荐；拒绝的行保留，之后的推荐据此排除 */
export async function reviewSuggestedSeller(
  actor: WorkbenchActor,
  id: string,
  decision: 'accept' | 'reject',
) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const row = await s.findById(directionSeller, id)
  if (row.status !== 'suggested')
    throw new AppError('INVALID_STATE', '只能处理系统推荐的店铺', { status: 409 })
  return toSellerRow(
    await s.updateById(directionSeller, id, {
      status: decision === 'accept' ? 'accepted' : 'rejected',
    }),
  )
}

/** 移出种子或已接受的店铺；被拒绝的记录保留以免再次被推荐 */
export async function removeSeller(actor: WorkbenchActor, id: string) {
  assertWorkbenchWriter(actor)
  const s = scoped(actor.db, actor.workspaceId)
  const row = await s.findById(directionSeller, id)
  if (row.status === 'rejected' || row.status === 'suggested')
    throw new AppError('INVALID_STATE', '推荐中的店铺请使用接受或拒绝', { status: 409 })
  await s.deleteById(directionSeller, id)
}
