import { softDeleteWorkspace } from '@product-res/auth/workspace-admission'
import {
  type Database,
  type WorkspaceTransfer,
  workspaceTransfer,
  workspaceTransferBatch,
} from '@product-res/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { dismissPendingWeightSuggestions, rebuildWorkspaceReadiness } from '../validation.ts'
import { lockTransferWorkspaces } from './access.ts'
import { auditTransfer, auditTransferCompleted } from './audit.ts'
import { countActions } from './batch.ts'
import { rows, type TransferSelection, type Tx, transferError, xactLock } from './common.ts'
import { col, ident, keyOf, type TableMeta, tableMeta } from './meta.ts'
import { loadTransfer, transition } from './plan.ts'
import { FLOWING_TRANSFER_TABLES } from './registry.ts'

/**
 * 完成与补偿回滚（design D8，tasks 3.5 / 3.6）。
 *
 * 补偿按批次逆序、每批一个事务撤销：
 * 1. 父先子后：被合并删除的源行从 `source_row.row` 重新插入（eBay 账号删除已清空的快照跳过）；
 * 2. moved / renamed / updated：有快照的逐列恢复（含空间与被改写的引用、原名），无快照的改回源空间；
 * 3. 子先父后：删除 copied 的目标行，被合并修改的目标行从 `source_row.target` 恢复。
 * 升级失败补偿完成后按现有流程软删新建的团队空间（只有发起人一个成员）。
 */

export interface TransferBatchState {
  readonly key: string
  readonly seq: number
  readonly status: 'pending' | 'done' | 'compensated'
}

/** 批次列表（按执行顺序），供 Workflow 逐步调用 runBatch */
export async function listTransferBatches(
  db: Database,
  transferId: string,
): Promise<TransferBatchState[]> {
  const batches = await db
    .select({
      key: workspaceTransferBatch.batchKey,
      seq: workspaceTransferBatch.seq,
      status: workspaceTransferBatch.status,
    })
    .from(workspaceTransferBatch)
    .where(eq(workspaceTransferBatch.transferId, transferId))
    .orderBy(workspaceTransferBatch.seq)
  return batches
}

export interface FinalizeResult {
  readonly status: 'completed'
  /** 升级时活跃空间被切换的会话 token，调用方据此失效会话缓存（KV） */
  readonly sessionTokens: readonly string[]
}

/** 全部批次完成后标记 completed；升级时把发起人的会话切换到新团队空间 */
export async function finalizeTransfer(db: Database, transferId: string): Promise<FinalizeResult> {
  return db.transaction(async (tx) => {
    const head = await loadTransfer(tx, transferId)
    await lockTransferWorkspaces(tx, [head.sourceWorkspaceId, head.targetWorkspaceId], {
      sellerData: false,
    })
    const transfer = await loadTransfer(tx, transferId, { forUpdate: true })
    if (transfer.status === 'completed')
      return { status: 'completed' as const, sessionTokens: transfer.sessionTokens }
    if (transfer.status !== 'running')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能完成`, 409)
    const [pending] = await rows(
      tx,
      sql`select batch_key from workspace_transfer_batch
        where transfer_id = ${transfer.id} and status <> 'done' limit 1`,
    )
    if (pending) throw transferError('TRANSFER_INCOMPLETE', '仍有未完成的批次', 409)
    let sessionTokens: string[] = []
    if (transfer.kind === 'upgrade') {
      const sessionId = (transfer.selection as TransferSelection).sessionId
      const filter = sessionId
        ? sql`id = ${sessionId}`
        : sql`active_organization_id = ${transfer.sourceWorkspaceId}`
      sessionTokens = (
        await rows<{ token: string }>(
          tx,
          sql`update session set active_organization_id = ${transfer.targetWorkspaceId}, updated_at = now()
            where user_id = ${transfer.requestedBy} and ${filter} and expires_at > now()
            returning token`,
        )
      ).map((r) => r.token)
    }
    const counts = await countActions(tx, transfer.id)
    const now = new Date()
    await transition(tx, transfer.id, ['running'], {
      status: 'completed',
      finishedAt: now,
      counts,
      sessionTokens,
    })
    // 审计与迁移同事务（tasks 5.1）；重试时上面已提前返回，不重复写
    await auditTransferCompleted(tx, transfer, counts)
    if (transfer.kind === 'move') await afterMove(tx, transfer, now)
    return { status: 'completed' as const, sessionTokens }
  })
}

/**
 * 进入补偿：pending / running / failed → compensating（completed 不提供回滚，用户可发起反向移动）。
 * errorCode 记录失败原因（如 TRANSFER_PERMISSION_REVOKED、超时或用户取消）。
 */
export async function beginCompensation(
  db: Database,
  transferId: string,
  errorCode: string,
): Promise<WorkspaceTransfer['status']> {
  return db.transaction(async (tx) => {
    const [transfer] = await tx
      .select()
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, transferId))
      .for('update')
    if (!transfer) throw transferError('TRANSFER_NOT_FOUND', '流转记录不存在', 404)
    if (transfer.status === 'compensating' || transfer.status === 'compensated')
      return transfer.status
    if (transfer.status === 'completed' || transfer.status === 'cancelled')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能回滚`, 409)
    await tx
      .update(workspaceTransfer)
      .set({ status: 'compensating', errorCode: transfer.errorCode ?? errorCode })
      .where(eq(workspaceTransfer.id, transferId))
    // 失败（含用户取消）在进入补偿时记审计，计数为已执行批次的结果
    await auditTransfer(tx, transfer, 'failed', {
      counts: await countActions(tx, transfer.id),
      errorCode: transfer.errorCode ?? errorCode,
    })
    return 'compensating' as const
  })
}

const entryOf = (alias: string, meta: TableMeta) => sql`${ident(meta.name)} ${sql.raw(alias)}`

/** 撤销一个 done 批次；已撤销或未执行的批次跳过 */
export async function compensateBatch(
  db: Database,
  transferId: string,
  batchKey: string,
): Promise<'compensated' | 'skipped'> {
  return db.transaction(async (tx) => {
    const head = await loadTransfer(tx, transferId)
    // 补偿可能从快照恢复卖家数据，总是与 eBay 账号删除互斥
    await lockTransferWorkspaces(tx, [head.sourceWorkspaceId, head.targetWorkspaceId], {
      sellerData: true,
    })
    const transfer = await loadTransfer(tx, transferId, { forUpdate: true })
    if (transfer.status !== 'compensating')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能补偿`, 409)
    const [batch] = await tx
      .select()
      .from(workspaceTransferBatch)
      .where(
        and(
          eq(workspaceTransferBatch.transferId, transferId),
          eq(workspaceTransferBatch.batchKey, batchKey),
        ),
      )
      .for('update')
    if (!batch) throw transferError('TRANSFER_BATCH_NOT_FOUND', '批次不存在', 404)
    if (batch.status !== 'done') return 'skipped' as const
    // 只能按批次逆序撤销：先撤销父批次会级联删掉仍挂在后续批次中的行（如复制的供应商 → 报价）
    const [later] = await rows<{ batch_key: string }>(
      tx,
      sql`select batch_key from workspace_transfer_batch
        where transfer_id = ${transfer.id} and seq > ${batch.seq} and status = 'done' limit 1`,
    )
    if (later)
      throw transferError('TRANSFER_COMPENSATION_ORDER', '须先撤销后续批次', 409, {
        pending: later.batch_key,
      })
    await undoBatch(tx, transfer, batchKey)
    await tx
      .update(workspaceTransferBatch)
      .set({ status: 'compensated' })
      .where(eq(workspaceTransferBatch.id, batch.id))
    return 'compensated' as const
  })
}

async function undoBatch(tx: Tx, transfer: WorkspaceTransfer, batchKey: string) {
  const metas = FLOWING_TRANSFER_TABLES.map((e) => tableMeta(e.name))
  const inBatch = (meta: TableMeta, actions: string) =>
    sql`m.transfer_id = ${transfer.id} and m.table_name = ${meta.name}
      and m.batch_key = ${batchKey} and m.action in (${sql.raw(actions)})`
  const restoreColumns = (meta: TableMeta) =>
    sql.join(
      meta.columns.map((c) => sql`${ident(c)} = ${col('r', c)}`),
      sql`, `,
    )
  // 1. 父先子后：重新插入被合并删除的源行
  for (const meta of metas) {
    await tx.execute(sql`insert into ${ident(meta.name)}
      select (jsonb_populate_record(null::${ident(meta.name)}, m.source_row->'row')).*
      from workspace_transfer_id_map m
      where ${inBatch(meta, "'merged'")} and m.source_row ? 'row'
        and not exists (select 1 from ${entryOf('t', meta)} where ${keyOf(meta, 't')} = m.source_id)
      on conflict do nothing`)
  }
  const reversed = [...metas].reverse()
  // 2. 移动的行回到源空间；有快照的逐列恢复
  for (const meta of reversed) {
    await tx.execute(sql`update ${entryOf('t', meta)} set ${restoreColumns(meta)}
      from workspace_transfer_id_map m
      cross join lateral jsonb_populate_record(null::${ident(meta.name)}, m.source_row->'row') r
      where ${inBatch(meta, "'moved','renamed','updated'")} and m.source_row ? 'row'
        and ${keyOf(meta, 't')} = m.source_id`)
    await tx.execute(sql`update ${entryOf('t', meta)}
      set ${ident(meta.ws)} = ${transfer.sourceWorkspaceId}
      from workspace_transfer_id_map m
      where ${inBatch(meta, "'moved','renamed'")}
        and (m.source_row is null or not m.source_row ? 'row')
        and ${keyOf(meta, 't')} = m.source_id
        and t.${ident(meta.ws)} = ${transfer.targetWorkspaceId}`)
  }
  // 3. 子先父后：删除复制到目标的行，恢复被合并修改的目标行
  for (const meta of reversed) {
    await tx.execute(sql`delete from ${entryOf('t', meta)}
      using workspace_transfer_id_map m
      where ${inBatch(meta, "'copied'")} and ${keyOf(meta, 't')} = m.target_id
        and t.${ident(meta.ws)} = ${transfer.targetWorkspaceId}`)
    await tx.execute(sql`update ${entryOf('t', meta)} set ${restoreColumns(meta)}
      from workspace_transfer_id_map m
      cross join lateral jsonb_populate_record(null::${ident(meta.name)}, m.source_row->'target') r
      where ${inBatch(meta, "'merged'")} and m.source_row ? 'target'
        and ${keyOf(meta, 't')} = m.target_id`)
  }
}

export interface CompensationResult {
  readonly status: 'compensated'
  /** 升级补偿软删新空间时清空的会话 token，调用方据此失效会话缓存（KV） */
  readonly sessionTokens: readonly string[]
}

/** 全部批次撤销后标记 compensated；升级时软删新建的团队空间 */
export async function completeCompensation(
  db: Database,
  transferId: string,
): Promise<CompensationResult> {
  return db.transaction(async (tx) => {
    const head = await loadTransfer(tx, transferId)
    if (head.status === 'compensated')
      return { status: 'compensated' as const, sessionTokens: head.sessionTokens }
    if (head.kind === 'upgrade') await xactLock(tx, `owner:${head.requestedBy}`)
    await lockTransferWorkspaces(tx, [head.sourceWorkspaceId, head.targetWorkspaceId], {
      sellerData: false,
    })
    const transfer = await loadTransfer(tx, transferId, { forUpdate: true })
    if (transfer.status === 'compensated')
      return { status: 'compensated' as const, sessionTokens: transfer.sessionTokens }
    if (transfer.status !== 'compensating')
      throw transferError('TRANSFER_STATE', `流转状态为 ${transfer.status}，不能完成补偿`, 409)
    const [left] = await rows(
      tx,
      sql`select batch_key from workspace_transfer_batch
        where transfer_id = ${transfer.id} and status = 'done' limit 1`,
    )
    if (left) throw transferError('TRANSFER_INCOMPLETE', '仍有未撤销的批次', 409)
    let sessionTokens: string[] = []
    if (transfer.kind === 'upgrade') {
      const [target] = await rows<{ deleted_at: string | null }>(
        tx,
        sql`select deleted_at from organization where id = ${transfer.targetWorkspaceId}`,
      )
      if (target && !target.deleted_at)
        sessionTokens = await softDeleteWorkspace(
          (strings, ...values) => rows(tx, sql(strings, ...(values as never[]))),
          transfer.targetWorkspaceId,
          transfer.requestedBy,
          null,
        )
    }
    const now = new Date()
    await transition(tx, transfer.id, ['compensating'], {
      status: 'compensated',
      finishedAt: now,
      sessionTokens,
    })
    await auditTransfer(tx, transfer, 'compensated', {
      counts: await countActions(tx, transfer.id),
      errorCode: transfer.errorCode,
    })
    // 合并方向时被级联删除的源准备度统计已由批次快照逐行恢复（undoBatch 第 1 步），这里不再重算，
    // 否则会改写恢复后的行，破坏“补偿后两边数据恢复到流转前”的要求
    return { status: 'compensated' as const, sessionTokens }
  })
}

/** 一次性补偿：进入 compensating → 逆序撤销全部 done 批次 → 完成（Workflow 也可逐步调用上面三步） */
export async function compensateTransfer(
  db: Database,
  transferId: string,
  errorCode: string,
): Promise<CompensationResult> {
  await beginCompensation(db, transferId, errorCode)
  // 循环到没有 done 批次：进入补偿前已开始的批次可能在第一次列出之后才提交
  for (;;) {
    const batches = await db
      .select({ key: workspaceTransferBatch.batchKey })
      .from(workspaceTransferBatch)
      .where(
        and(
          eq(workspaceTransferBatch.transferId, transferId),
          eq(workspaceTransferBatch.status, 'done'),
        ),
      )
      .orderBy(desc(workspaceTransferBatch.seq))
    if (batches.length === 0) break
    for (const batch of batches) await compensateBatch(db, transferId, batch.key)
  }
  return completeCompensation(db, transferId)
}

// 派生统计重算接收 Database；事务对象提供同样的查询接口，在流转锁与状态迁移的同一事务内执行
const asDatabase = (tx: Tx) => tx as unknown as Database

/**
 * move 完成后（tasks 4.2，design D3 readiness_stat / weight_suggestion）：两边的准备度都基于残缺样本，
 * 在流转锁内重算；源空间未处理的权重建议作废（resolved_by 记发起人）。与 completed 同事务，重试幂等。
 */
async function afterMove(tx: Tx, transfer: WorkspaceTransfer, now: Date) {
  await rebuildWorkspaceReadiness(asDatabase(tx), transfer.sourceWorkspaceId, { now })
  await rebuildWorkspaceReadiness(asDatabase(tx), transfer.targetWorkspaceId, { now })
  await dismissPendingWeightSuggestions(
    asDatabase(tx),
    transfer.sourceWorkspaceId,
    transfer.requestedBy,
    now,
  )
}
