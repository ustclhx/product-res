import {
  cluster,
  clusterMember,
  type Database,
  direction,
  ensureSelectionDefaults,
  lead,
  leadEvent,
  marketplaceProduct,
  scoped,
  scoringSetting,
  type TrackedStore,
} from '@product-res/db'
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { SaleSignal } from './rules.ts'

/**
 * “店铺新品出单”线索（design D5，specs/store-tracking「店铺新品出单线索」）。
 * 与品类洞察转线索相同的接入方式：在店铺关联的方向（没有则取覆盖该站点的第一个启用方向）下
 * 为该商品复用或创建单成员簇与线索，lead_event 备注记来源；之后由每日选品流水线照常打分。
 * 同一空间同一商品只生成一次（按 lead_event 的来源 + 商品去重）。
 */

export const STORE_LEAD_SOURCE = 'store-new-sale'

export type StoreLeadOutcome =
  | { readonly status: 'created'; readonly leadId: string; readonly directionId: string }
  | { readonly status: 'duplicate' }
  | { readonly status: 'no-direction' }

/** 本空间已生成过店铺新品出单线索的商品 */
export async function storeLeadProducts(db: Database, workspaceId: string) {
  const rows = await scoped(db, workspaceId).select(leadEvent, {
    fields: { productId: sql<string>`${leadEvent.payload}->>'productId'` },
    where: sql`${leadEvent.payload}->>'source' = ${STORE_LEAD_SOURCE}`,
  })
  return new Set(rows.map((r) => r.productId))
}

export async function createStoreSaleLead(
  db: Database,
  workspaceId: string,
  input: {
    readonly productId: string
    readonly store: Pick<TrackedStore, 'id' | 'sellerKey' | 'directionIds' | 'marketplace'>
    readonly signal: SaleSignal
    readonly firstSeenOn: string
    readonly day: string
  },
): Promise<StoreLeadOutcome> {
  const s = scoped(db, workspaceId)
  const [product] = await db
    .select({
      id: marketplaceProduct.id,
      title: marketplaceProduct.title,
      platformId: marketplaceProduct.platformId,
      marketplace: marketplaceProduct.marketplace,
    })
    .from(marketplaceProduct)
    .where(eq(marketplaceProduct.id, input.productId))
  if (!product) return { status: 'no-direction' }
  const enabled = (
    await s
      .select(direction, { where: eq(direction.enabled, true) })
      .orderBy(asc(direction.createdAt))
  ).filter((d) => d.marketplaces.includes(product.marketplace))
  const dir = enabled.find((d) => input.store.directionIds.includes(d.id)) ?? enabled[0]
  if (!dir) return { status: 'no-direction' }
  await ensureSelectionDefaults(db, workspaceId)
  const [setting] = await s
    .select(scoringSetting, { fields: { version: scoringSetting.version } })
    .orderBy(desc(scoringSetting.version))
    .limit(1)

  return s.transaction(async (tx) => {
    // 事务内再查一次，避免并发的两轮重复生成
    const [seen] = await tx
      .select(leadEvent, {
        fields: { id: leadEvent.id },
        where: and(
          sql`${leadEvent.payload}->>'source' = ${STORE_LEAD_SOURCE}`,
          sql`${leadEvent.payload}->>'productId' = ${product.id}`,
        ) as SQL,
      })
      .limit(1)
    if (seen) return { status: 'duplicate' as const }
    const memberOf = tx.select(clusterMember, {
      where: eq(clusterMember.productId, product.id),
      fields: { clusterId: clusterMember.clusterId },
    })
    const [existing] = await tx
      .select(cluster, {
        where: and(
          eq(cluster.directionId, dir.id),
          eq(cluster.status, 'active'),
          inArray(cluster.id, memberOf),
        ) as SQL,
      })
      .orderBy(asc(cluster.createdAt))
      .limit(1)
    let clusterId = existing?.id
    if (!clusterId) {
      const [created] = await tx
        .insert(cluster, {
          directionId: dir.id,
          marketplace: product.marketplace,
          representativeProductId: product.id,
          name: product.title ?? product.platformId,
        })
        .returning({ id: cluster.id })
      clusterId = created?.id as string
      // 店铺新品单独成簇并锁定：自动归并不把它并入其他簇
      await tx.insert(clusterMember, {
        clusterId,
        productId: product.id,
        method: 'manual',
        confidence: 1,
        locked: true,
      })
    }
    // 簇当天已有线索（流水线已生成）时复用，不重复
    const [today] = await tx
      .select(lead, {
        fields: { id: lead.id },
        where: and(eq(lead.clusterId, clusterId), eq(lead.leadOn, input.day)) as SQL,
      })
      .limit(1)
    let leadId = today?.id
    if (!leadId) {
      const [previous] = await tx
        .select(lead, { where: eq(lead.clusterId, clusterId) })
        .orderBy(desc(lead.leadOn))
        .limit(1)
      const [created] = await tx
        .insert(lead, {
          clusterId,
          directionId: dir.id,
          leadOn: input.day,
          settingVersion: setting?.version ?? 1,
          // 沿用该簇之前的处理状态与跟卖方式，不覆盖团队已做的决定
          status: previous?.status ?? 'new',
          followMode: previous?.followMode ?? 'same-source',
          improvement: previous?.improvement ?? null,
        })
        .returning({ id: lead.id })
      leadId = created?.id as string
    }
    await tx.insert(leadEvent, {
      leadId,
      clusterId,
      kind: 'note',
      payload: {
        source: STORE_LEAD_SOURCE,
        productId: product.id,
        storeId: input.store.id,
        sellerKey: input.store.sellerKey,
        firstSeenOn: input.firstSeenOn,
        signal: { ...input.signal },
      },
    })
    return { status: 'created' as const, leadId, directionId: dir.id }
  })
}
