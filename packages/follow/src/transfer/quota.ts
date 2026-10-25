import type { WorkspaceTransfer } from '@product-res/db'
import { normalizePhrase } from '@product-res/marketdata'
import { sql } from 'drizzle-orm'
import { storeSellerTarget } from '../stores/collect.ts'
import { rows, TRANSFER_QUOTA_WARN_CALLS, type Tx } from './common.ts'
import type { TransferConflictDecision } from './plan.ts'

/**
 * 外部额度增量估算（design「决定」：采集在计划阶段已跨空间按卖家 × 搜索条件去重）。
 * 店铺与追踪商品原样移动不产生新的 Browse 调用；只有卖家的搜索条件（类目或关键词）在流转后变化时
 * 才会新增任务：店铺并入关联了其他方向的目标店铺、方向合并到类目 / 关键词不同的目标方向。
 * 结果是每日新增 eBay 卖家新品任务数的上限（其他空间可能已在扫描同一条件）。
 */
export interface QuotaEstimate {
  readonly additionalBrowseCallsPerDay: number
  readonly threshold: number
  readonly exceeds: boolean
}

interface DirectionRow {
  id: string
  keywords: string[]
  category_ids: string[]
  enabled: boolean
}

interface StoreRow {
  id: string
  marketplace: string
  seller_key: string
  keywords: string[]
  direction_ids: string[]
}

type DirectionState = { keywords: string[]; categoryIds: string[]; enabled: boolean }

const state = (d: DirectionRow): DirectionState => ({
  keywords: d.keywords,
  categoryIds: d.category_ids,
  enabled: d.enabled,
})

/** 与 collect.ts sellerCandidates 一致：有类目按类目拆分，否则按规范化关键词 */
function filters(target: { categoryIds: readonly string[]; keywords: readonly string[] }) {
  return new Set(
    target.categoryIds.length > 0
      ? target.categoryIds.map((c) => `c:${c}`)
      : target.keywords
          .map(normalizePhrase)
          .filter(Boolean)
          .map((q) => `q:${q}`),
  )
}

const added = (after: Set<string>, before: Set<string>) =>
  [...after].filter((f) => !before.has(f)).length

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

export async function estimateQuota(
  tx: Tx,
  transfer: WorkspaceTransfer,
  conflicts: readonly TransferConflictDecision[],
): Promise<QuotaEstimate> {
  const decision = new Map(conflicts.map((c) => [`${c.table}:${c.sourceId}`, c]))
  const directions = (ws: string) =>
    rows<DirectionRow>(
      tx,
      sql`select id, to_jsonb(keywords) as keywords, to_jsonb(category_ids) as category_ids, enabled
        from direction where workspace_id = ${ws}`,
    )
  const before = new Map((await directions(transfer.sourceWorkspaceId)).map((d) => [d.id, d]))
  const target = new Map((await directions(transfer.targetWorkspaceId)).map((d) => [d.id, d]))
  const planned = await rows<{ source_id: string }>(
    tx,
    sql`select source_id from workspace_transfer_id_map
      where transfer_id = ${transfer.id} and table_name = 'direction'`,
  )
  // 流转后的方向状态：目标已有方向 + 流入的方向（合并的取并集）
  const after = new Map<string, DirectionState>([...target].map(([id, d]) => [id, state(d)]))
  const mapped = new Map<string, string>()
  for (const { source_id } of planned) {
    const s = before.get(source_id)
    if (!s) continue
    const merge = decision.get(`direction:${source_id}`)
    if (merge?.action === 'merge' && merge.targetId) {
      const t = after.get(merge.targetId)
      if (t)
        after.set(merge.targetId, {
          keywords: union(t.keywords, s.keywords),
          categoryIds: union(t.categoryIds, s.category_ids),
          enabled: t.enabled,
        })
      mapped.set(source_id, merge.targetId)
    } else {
      after.set(source_id, state(s))
      mapped.set(source_id, source_id)
    }
  }
  const beforeStates = new Map([...before].map(([id, d]) => [id, state(d)]))
  const targetStates = new Map([...target].map(([id, d]) => [id, state(d)]))
  let total = 0

  const stores = await rows<StoreRow & { target_id: string | null }>(
    tx,
    sql`select s.id, s.marketplace, s.seller_key, to_jsonb(s.keywords) as keywords,
        to_jsonb(s.direction_ids) as direction_ids, null as target_id
      from tracked_store s join workspace_transfer_id_map m on m.transfer_id = ${transfer.id}
        and m.table_name = 'tracked_store' and m.source_id = s.id::text
      where s.workspace_id = ${transfer.sourceWorkspaceId} and s.platform = 'ebay'
        and s.status = 'active'`,
  )
  for (const s of stores) {
    const store = { sellerKey: s.seller_key, marketplace: s.marketplace }
    const was = filters(
      storeSellerTarget(
        { ...store, keywords: s.keywords, directionIds: s.direction_ids },
        beforeStates,
      ),
    )
    const ids = s.direction_ids.flatMap((id) => {
      const to = mapped.get(id)
      return to ? [to] : []
    })
    const merge = decision.get(`tracked_store:${s.id}`)
    let next = { keywords: s.keywords, directionIds: ids }
    if (merge?.action === 'merge' && merge.targetId) {
      const [g] = await rows<StoreRow>(
        tx,
        sql`select id, marketplace, seller_key, to_jsonb(keywords) as keywords,
          to_jsonb(direction_ids) as direction_ids from tracked_store
          where id = ${merge.targetId}`,
      )
      if (g) {
        for (const f of filters(
          storeSellerTarget(
            { ...store, keywords: g.keywords, directionIds: g.direction_ids },
            targetStates,
          ),
        ))
          was.add(f)
        next = { keywords: g.keywords, directionIds: union(g.direction_ids, ids) }
      }
    }
    total += added(filters(storeSellerTarget({ ...store, ...next }, after)), was)
  }

  // 方向合并：对标店铺按合并后的方向条件扫描
  const merges = conflicts.filter((c) => c.table === 'direction' && c.action === 'merge')
  for (const merge of merges) {
    const s = beforeStates.get(merge.sourceId)
    const t = merge.targetId ? after.get(merge.targetId) : undefined
    if (!s || !t?.enabled) continue
    const sellers = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from direction_seller
        where direction_id = ${merge.sourceId} and marketplace like 'ebay-%'
          and status in ('seed', 'accepted')`,
    )
    const was = s.enabled ? filters(s) : new Set<string>()
    total += (sellers[0]?.n ?? 0) * added(filters(t), was)
  }
  return {
    additionalBrowseCallsPerDay: total,
    threshold: TRANSFER_QUOTA_WARN_CALLS,
    exceeds: total > TRANSFER_QUOTA_WARN_CALLS,
  }
}
