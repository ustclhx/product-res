import type { WorkspaceTransfer, WorkspaceTransferCounts } from '@product-res/db'
import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import { rows, type Tx } from './common.ts'

/**
 * 流转审计（design D10，tasks 5.1）。
 *
 * - 已有 audit_log 行不改 workspace_id，留在源空间；这里只追加新行。
 * - `workspace.transfer.requested / completed / failed / compensated` 在源与目标各写一行，
 *   meta 带 transferId、kind、对方空间 id 与按表计数（表名 → 动作 → 行数）。
 * - 升级另写 `workspace.created_from_personal`（目标）、新 owner 的 `workspace.member_added`（目标）
 *   与完成时的 `workspace.upgraded`（源）。
 * - 每个写入点都在对应状态迁移的同一事务里调用；状态迁移按期望状态条件更新、重试时提前返回，
 *   因此审计随迁移恰好写一次。
 */

export type TransferAuditEvent = 'requested' | 'completed' | 'failed' | 'compensated'

export const TRANSFER_AUDIT_TARGET = 'workspace_transfer'

type AuditSubject = Pick<
  WorkspaceTransfer,
  'id' | 'kind' | 'sourceWorkspaceId' | 'targetWorkspaceId' | 'requestedBy'
>

async function insertAudit(
  tx: Tx,
  input: {
    readonly actor: string
    readonly workspaceId: string
    readonly action: string
    readonly targetType: string
    readonly targetId: string
    readonly meta: Record<string, unknown>
  },
) {
  // audit_log 对 app 只追加；与 packages/auth 的审计写法一致使用原始 SQL
  await tx.execute(sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,meta)
    values (${newId()},${input.actor},${input.workspaceId},${input.action},${input.targetType},
      ${input.targetId},${JSON.stringify(input.meta)}::jsonb)`)
}

/** 源与目标各写一行 `workspace.transfer.<event>` */
export async function auditTransfer(
  tx: Tx,
  transfer: AuditSubject,
  event: TransferAuditEvent,
  extra: {
    readonly counts?: WorkspaceTransferCounts
    readonly errorCode?: string | null
    /** 用户取消时的真实操作人（可能不是发起人）；审计 actor 与 meta.cancelledBy 均记此人 */
    readonly cancelledBy?: string
  } = {},
): Promise<void> {
  const sides = [
    { side: 'source', workspaceId: transfer.sourceWorkspaceId, other: transfer.targetWorkspaceId },
    { side: 'target', workspaceId: transfer.targetWorkspaceId, other: transfer.sourceWorkspaceId },
  ] as const
  for (const { side, workspaceId, other } of sides)
    await insertAudit(tx, {
      actor: extra.cancelledBy ?? transfer.requestedBy,
      workspaceId,
      action: `workspace.transfer.${event}`,
      targetType: TRANSFER_AUDIT_TARGET,
      targetId: transfer.id,
      meta: {
        transferId: transfer.id,
        kind: transfer.kind,
        side,
        counterpartWorkspaceId: other,
        counts: extra.counts ?? {},
        ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
        ...(extra.cancelledBy ? { cancelledBy: extra.cancelledBy } : {}),
      },
    })
}

/** 发起：requested；升级另写新团队空间的创建与 owner 成员加入 */
export async function auditTransferRequested(tx: Tx, transfer: AuditSubject): Promise<void> {
  await auditTransfer(tx, transfer, 'requested')
  if (transfer.kind !== 'upgrade') return
  await insertAudit(tx, {
    actor: transfer.requestedBy,
    workspaceId: transfer.targetWorkspaceId,
    action: 'workspace.created_from_personal',
    targetType: 'organization',
    targetId: transfer.targetWorkspaceId,
    meta: { transferId: transfer.id, sourceWorkspaceId: transfer.sourceWorkspaceId },
  })
  const [owner] = await rows<{ id: string }>(
    tx,
    sql`select id from member
      where organization_id = ${transfer.targetWorkspaceId} and user_id = ${transfer.requestedBy}`,
  )
  if (!owner) throw new Error(`upgrade target ${transfer.targetWorkspaceId} has no owner member`)
  // 与 packages/auth 团队创建的 member_added 同一 meta 形状
  await insertAudit(tx, {
    actor: transfer.requestedBy,
    workspaceId: transfer.targetWorkspaceId,
    action: 'workspace.member_added',
    targetType: 'member',
    targetId: owner.id,
    meta: {
      targetUserId: transfer.requestedBy,
      oldRole: null,
      newRole: 'owner',
      transferId: transfer.id,
    },
  })
}

/** 完成：completed；升级另在源空间写 workspace.upgraded */
export async function auditTransferCompleted(
  tx: Tx,
  transfer: AuditSubject,
  counts: WorkspaceTransferCounts,
): Promise<void> {
  await auditTransfer(tx, transfer, 'completed', { counts })
  if (transfer.kind !== 'upgrade') return
  await insertAudit(tx, {
    actor: transfer.requestedBy,
    workspaceId: transfer.sourceWorkspaceId,
    action: 'workspace.upgraded',
    targetType: 'organization',
    targetId: transfer.targetWorkspaceId,
    meta: { transferId: transfer.id, targetWorkspaceId: transfer.targetWorkspaceId, counts },
  })
}
