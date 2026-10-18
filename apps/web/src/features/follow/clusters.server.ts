import {
  cluster,
  clusterMember,
  lead,
  leadEvent,
  marketplaceProduct,
  type Scoped,
  scoped,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm'
import { productRefreshOptions, refreshNow } from '../data-center/service.server.ts'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import type { WorkbenchActor } from '../workbench/actor.ts'

/**
 * 商品簇的手动修正与人工刷新（specs/product-clustering「手动拆分与合并」、specs/follow-candidates）。
 * 写操作要求可写空间的 owner / admin；被移动的成员改为 manual、置信度 1 并锁定，
 * 之后的自动归并不再改动（与 packages/selection 的 splitMember / mergeClusters 一致），
 * 每次修正写一条 lead_event，挂到该簇最新的线索上（没有线索时只记簇）。
 */

const invalid = (message: string) => new AppError('INVALID_INPUT', message, { status: 400 })

async function latestLeadId(s: Scoped, clusterId: string) {
  const [row] = await s
    .select(lead, { where: eq(lead.clusterId, clusterId), fields: { id: lead.id } })
    .orderBy(desc(lead.leadOn))
    .limit(1)
  return row?.id ?? null
}

async function activeCluster(s: Scoped, id: string) {
  const c = await s.findById(cluster, id)
  if (c.status !== 'active') throw invalid('该商品簇已被合并或归档，不能再修改')
  return c
}

/** 把一个成员拆成单独的新簇；簇里只剩这一个成员时不能拆 */
export async function splitClusterMember(
  actor: WorkbenchActor,
  input: { clusterId: string; memberId: string; actorUserId?: string | null },
) {
  assertWorkbenchWriter(actor)
  return scoped(actor.db, actor.workspaceId).transaction(async (s) => {
    const source = await activeCluster(s, input.clusterId)
    const member = await s.findById(clusterMember, input.memberId)
    if (member.clusterId !== source.id) throw invalid('该成员不在此商品簇中')
    const others = await s.select(clusterMember, {
      where: and(eq(clusterMember.clusterId, source.id), ne(clusterMember.id, member.id)) as SQL,
    })
    if (others.length === 0) throw invalid('商品簇只有这一个成员，无需拆分')

    const [product] = await actor.db
      .select({ title: marketplaceProduct.title, platformId: marketplaceProduct.platformId })
      .from(marketplaceProduct)
      .where(eq(marketplaceProduct.id, member.productId))
    const [created] = await s
      .insert(cluster, {
        directionId: source.directionId,
        marketplace: source.marketplace,
        representativeProductId: member.productId,
        name: product?.title ?? product?.platformId ?? source.name,
      })
      .returning()
    if (!created) throw new Error('cluster insert returned no row')
    await s.update(
      clusterMember,
      { clusterId: created.id, method: 'manual', confidence: 1, locked: true },
      eq(clusterMember.id, member.id),
    )
    // 代表商品被拆走时，原簇改用剩余成员中归并置信度最高的
    if (source.representativeProductId === member.productId) {
      const next = [...others].sort((a, b) => b.confidence - a.confidence)[0]
      await s.update(
        cluster,
        { representativeProductId: next?.productId ?? null },
        eq(cluster.id, source.id),
      )
    }
    const payload = {
      memberId: member.id,
      productId: member.productId,
      fromClusterId: source.id,
      toClusterId: created.id,
      previousMethod: member.method,
      previousConfidence: member.confidence,
    }
    await s.insert(leadEvent, [
      {
        clusterId: source.id,
        leadId: await latestLeadId(s, source.id),
        kind: 'split',
        payload,
        actorUserId: input.actorUserId ?? null,
      },
      { clusterId: created.id, kind: 'split', payload, actorUserId: input.actorUserId ?? null },
    ])
    return { clusterId: created.id }
  })
}

/**
 * 把另一个簇（from）并入当前簇（into）：from 的成员移入并锁定，from 标记为 merged。
 * 只能合并同一方向、同一站点的簇（簇按站点划分，跨站点同款只作为属性展示）。
 */
export async function mergeIntoCluster(
  actor: WorkbenchActor,
  input: { intoClusterId: string; fromClusterId: string; actorUserId?: string | null },
) {
  assertWorkbenchWriter(actor)
  if (input.intoClusterId === input.fromClusterId) throw invalid('不能与自身合并')
  return scoped(actor.db, actor.workspaceId).transaction(async (s) => {
    const into = await activeCluster(s, input.intoClusterId)
    const from = await activeCluster(s, input.fromClusterId)
    if (into.directionId !== from.directionId || into.marketplace !== from.marketplace)
      throw invalid('只能合并同一方向、同一站点的商品簇')
    const [fromMembers, intoMembers] = await Promise.all([
      s.select(clusterMember, { where: eq(clusterMember.clusterId, from.id) }),
      s.select(clusterMember, {
        where: eq(clusterMember.clusterId, into.id),
        fields: { productId: clusterMember.productId },
      }),
    ])
    const present = new Set(intoMembers.map((m) => m.productId))
    const duplicates = fromMembers.filter((m) => present.has(m.productId)).map((m) => m.id)
    const moving = fromMembers.filter((m) => !present.has(m.productId)).map((m) => m.id)
    // 同一商品已在目标簇中时删除重复的成员行（唯一索引 cluster_id + product_id）
    if (duplicates.length) await s.delete(clusterMember, inArray(clusterMember.id, duplicates))
    if (moving.length)
      await s.update(
        clusterMember,
        { clusterId: into.id, method: 'manual', confidence: 1, locked: true },
        inArray(clusterMember.id, moving),
      )
    await s.update(cluster, { status: 'merged', mergedIntoId: into.id }, eq(cluster.id, from.id))
    const payload = {
      fromClusterId: from.id,
      intoClusterId: into.id,
      memberIds: fromMembers.map((m) => m.id),
      productIds: fromMembers.map((m) => m.productId),
    }
    await s.insert(leadEvent, [
      {
        clusterId: into.id,
        leadId: await latestLeadId(s, into.id),
        kind: 'merge',
        payload,
        actorUserId: input.actorUserId ?? null,
      },
      {
        clusterId: from.id,
        leadId: await latestLeadId(s, from.id),
        kind: 'merge',
        payload,
        actorUserId: input.actorUserId ?? null,
      },
    ])
    return { clusterId: into.id, moved: moving.length }
  })
}

/** 成员对应的平台商品（校验成员属于本空间、本簇） */
async function memberProduct(actor: WorkbenchActor, clusterId: string, memberId: string) {
  const s = scoped(actor.db, actor.workspaceId)
  const member = await s.findById(clusterMember, memberId)
  if (member.clusterId !== clusterId) throw invalid('该成员不在此商品簇中')
  const [product] = await actor.db
    .select({
      marketplace: marketplaceProduct.marketplace,
      platformId: marketplaceProduct.platformId,
    })
    .from(marketplaceProduct)
    .where(eq(marketplaceProduct.id, member.productId))
  if (!product) throw new AppError('NOT_FOUND', 'Product not found', { status: 404 })
  return product
}

/** 单个商品的人工刷新选项：支持该站点商品快照的数据源、预计花费与当前额度 */
export async function memberRefreshOptions(
  actor: WorkbenchActor,
  input: { clusterId: string; memberId: string },
) {
  const product = await memberProduct(actor, input.clusterId, input.memberId)
  return {
    marketplace: product.marketplace,
    platformId: product.platformId,
    options: await productRefreshOptions(actor.db, product.marketplace, [product.platformId]),
  }
}

/** 对单个商品执行人工刷新：复用数据中心的 refreshNow（遵守额度，可用到硬上限） */
export async function refreshMember(
  actor: WorkbenchActor,
  input: { clusterId: string; memberId: string; sourceId: string },
) {
  assertWorkbenchWriter(actor)
  const product = await memberProduct(actor, input.clusterId, input.memberId)
  return refreshNow(actor.db, {
    sourceId: input.sourceId,
    kind: 'product-snapshot',
    marketplace: product.marketplace,
    ids: [product.platformId],
  })
}
