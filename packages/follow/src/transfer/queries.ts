import {
  type Database,
  type WorkspaceTransfer,
  type WorkspaceTransferCounts,
  workspaceTransfer,
  workspaceTransferBatch,
} from '@product-res/db'
import { desc, eq, or, type SQL, sql } from 'drizzle-orm'
import type { TransferConflictDecision, TransferPlan } from './plan.ts'
import { FLOWING_TRANSFER_TABLES } from './registry.ts'

/**
 * 流转记录的只读查询（tasks 4.1 服务端入口，供 W4 的流转记录页、升级预览与 /admin/workspaces 使用）。
 * 流转表同时关联两个空间、不经 scoped()；调用方须先确认请求者属于所查空间（或为平台管理员）。
 */

export interface TransferSummary {
  readonly id: string
  readonly kind: WorkspaceTransfer['kind']
  readonly status: WorkspaceTransfer['status']
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly sourceName: string | null
  readonly targetName: string | null
  readonly requestedBy: string
  readonly requestedByName: string | null
  readonly errorCode: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** 批次进度：已完成（或已撤销）/ 总数；plan 之前为 0 / 0 */
  readonly progress: { readonly done: number; readonly compensated: number; readonly total: number }
}

export interface TransferReportEntry {
  readonly table: string
  readonly sourceId: string
  readonly action: 'skipped' | 'renamed' | 'merged' | 'keep-target' | 'rename' | 'merge'
  readonly label?: string
  readonly newName?: string
  readonly targetId?: string | null
}

export interface TransferDetail extends TransferSummary {
  /** 按表计数：完成后为最终结果，进行中为已执行批次的累计 */
  readonly counts: WorkspaceTransferCounts
  /** 计划阶段按表统计的行数（plan.tables） */
  readonly plannedTables: Readonly<Record<string, number>>
  readonly batches: readonly {
    readonly key: string
    readonly seq: number
    readonly status: 'pending' | 'done' | 'compensated'
    readonly counts: WorkspaceTransferCounts
  }[]
  /** 冲突决定（预览中的重命名 / 合并 / 保留目标）与执行时的跳过 / 重命名清单 */
  readonly conflicts: readonly TransferConflictDecision[]
  readonly skipped: readonly TransferReportEntry[]
  readonly renamed: readonly TransferReportEntry[]
  readonly quota: TransferPlan['quota'] | null
}

const LIST_LIMIT = 50

const query = async <T>(db: Database, statement: SQL): Promise<T[]> =>
  (await db.execute(statement)) as unknown as T[]

const iso = (value: Date | string | null) =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString()

async function summaries(
  db: Database,
  transfers: readonly WorkspaceTransfer[],
): Promise<TransferSummary[]> {
  if (transfers.length === 0) return []
  const ids = transfers.map((t) => t.id)
  const workspaceIds = [
    ...new Set(transfers.flatMap((t) => [t.sourceWorkspaceId, t.targetWorkspaceId])),
  ]
  const userIds = [...new Set(transfers.map((t) => t.requestedBy))]
  const list = (values: readonly string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )
  const names = await query<{ id: string; name: string }>(
    db,
    sql`select id, name from organization where id in (${list(workspaceIds)})`,
  )
  const users = await query<{ id: string; name: string }>(
    db,
    sql`select id, name from "user" where id in (${list(userIds)})`,
  )
  const progress = await query<{ transfer_id: string; status: string; n: number }>(
    db,
    sql`select transfer_id, status, count(*)::int as n from workspace_transfer_batch
      where transfer_id in (${list(ids)}) group by transfer_id, status`,
  )
  const nameOf = new Map(names.map((n) => [n.id, n.name]))
  const userOf = new Map(users.map((u) => [u.id, u.name]))
  return transfers.map((t) => {
    const mine = progress.filter((p) => p.transfer_id === t.id)
    const count = (status: string) => mine.find((p) => p.status === status)?.n ?? 0
    return {
      id: t.id,
      kind: t.kind,
      status: t.status,
      sourceWorkspaceId: t.sourceWorkspaceId,
      targetWorkspaceId: t.targetWorkspaceId,
      sourceName: nameOf.get(t.sourceWorkspaceId) ?? null,
      targetName: nameOf.get(t.targetWorkspaceId) ?? null,
      requestedBy: t.requestedBy,
      requestedByName: userOf.get(t.requestedBy) ?? null,
      errorCode: t.errorCode,
      createdAt: iso(t.createdAt) as string,
      startedAt: iso(t.startedAt),
      finishedAt: iso(t.finishedAt),
      progress: {
        done: count('done'),
        compensated: count('compensated'),
        total: mine.reduce((sum, p) => sum + p.n, 0),
      },
    }
  })
}

/** 某空间作为源或目标的流转记录，最新在前 */
export async function listWorkspaceTransfers(
  db: Database,
  workspaceId: string,
  options: { readonly limit?: number } = {},
): Promise<TransferSummary[]> {
  const transfers = await db
    .select()
    .from(workspaceTransfer)
    .where(
      or(
        eq(workspaceTransfer.sourceWorkspaceId, workspaceId),
        eq(workspaceTransfer.targetWorkspaceId, workspaceId),
      ),
    )
    .orderBy(desc(workspaceTransfer.createdAt))
    .limit(Math.min(options.limit ?? LIST_LIMIT, LIST_LIMIT))
  return summaries(db, transfers)
}

/**
 * 单条详情；workspaceId 给出时只返回以该空间为源或目标的流转（否则视为不存在），
 * 平台管理员的只读查询省略它。
 */
export async function getWorkspaceTransferDetail(
  db: Database,
  transferId: string,
  workspaceId?: string,
): Promise<TransferDetail | null> {
  const [transfer] = await db
    .select()
    .from(workspaceTransfer)
    .where(eq(workspaceTransfer.id, transferId))
  if (!transfer) return null
  if (
    workspaceId !== undefined &&
    transfer.sourceWorkspaceId !== workspaceId &&
    transfer.targetWorkspaceId !== workspaceId
  )
    return null
  const [summary] = await summaries(db, [transfer])
  const batches = await db
    .select({
      key: workspaceTransferBatch.batchKey,
      seq: workspaceTransferBatch.seq,
      status: workspaceTransferBatch.status,
      counts: workspaceTransferBatch.counts,
    })
    .from(workspaceTransferBatch)
    .where(eq(workspaceTransferBatch.transferId, transferId))
    .orderBy(workspaceTransferBatch.seq)
  const plan = transfer.plan as unknown as TransferPlan | null
  const report = await query<{
    table_name: string
    source_id: string
    target_id: string | null
    action: 'skipped' | 'renamed'
  }>(
    db,
    sql`select table_name, source_id, target_id, action from workspace_transfer_id_map
      where transfer_id = ${transferId} and action in ('skipped', 'renamed')
      order by table_name, source_id limit 500`,
  )
  const decisionOf = new Map(
    (plan?.conflicts ?? []).map((c) => [`${c.table}:${c.sourceId}`, c] as const),
  )
  const entry = (r: (typeof report)[number]): TransferReportEntry => {
    const decision = decisionOf.get(`${r.table_name}:${r.source_id}`)
    return {
      table: r.table_name,
      sourceId: r.source_id,
      action: r.action,
      targetId: r.target_id,
      ...(decision?.label ? { label: decision.label } : {}),
      ...(decision?.newName ? { newName: decision.newName } : {}),
    }
  }
  // 进行中的流转 counts 列尚未写入：按已完成批次累加
  const counts: WorkspaceTransferCounts =
    transfer.status === 'completed' ? transfer.counts : mergeCounts(batches.map((b) => b.counts))
  return {
    ...(summary as TransferSummary),
    counts,
    plannedTables: plan?.tables ?? {},
    batches,
    conflicts: plan?.conflicts ?? [],
    skipped: report.filter((r) => r.action === 'skipped').map(entry),
    renamed: report.filter((r) => r.action === 'renamed').map(entry),
    quota: plan?.quota ?? null,
  }
}

function mergeCounts(list: readonly WorkspaceTransferCounts[]): WorkspaceTransferCounts {
  const out: Record<string, Record<string, number>> = {}
  for (const counts of list)
    for (const [table, actions] of Object.entries(counts))
      for (const [action, n] of Object.entries(actions ?? {})) {
        out[table] ??= {}
        out[table][action] = (out[table][action] ?? 0) + (n ?? 0)
      }
  return out
}

/** 升级预览：个人空间中每张参与流转的表的行数（升级整表移动，D3） */
export async function upgradeTableCounts(
  db: Database,
  workspaceId: string,
): Promise<Record<string, number>> {
  const parts = FLOWING_TRANSFER_TABLES.map(
    (entry) =>
      sql`select ${entry.name}::text as table_name, count(*)::int as n from ${sql.raw(`"${entry.name}"`)}
        where workspace_id = ${workspaceId}`,
  )
  const result = await query<{ table_name: string; n: number }>(
    db,
    sql.join(parts, sql` union all `),
  )
  return Object.fromEntries(result.map((r) => [r.table_name, r.n]))
}
