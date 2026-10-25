import { and, eq, inArray, or } from 'drizzle-orm'
import type { Database } from './client.ts'
import { WORKSPACE_TRANSFER_ACTIVE_STATUSES, workspaceTransfer } from './schema/transfer.ts'

/** 流转同时涉及两个空间，不经 scoped；供请求写权限与系统任务读取流转锁。 */
export async function isWorkspaceTransferring(db: Database, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: workspaceTransfer.id })
    .from(workspaceTransfer)
    .where(
      and(
        inArray(workspaceTransfer.status, [...WORKSPACE_TRANSFER_ACTIVE_STATUSES]),
        or(
          eq(workspaceTransfer.sourceWorkspaceId, workspaceId),
          eq(workspaceTransfer.targetWorkspaceId, workspaceId),
        ),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** 一次查询返回全部进行中流转的源 / 目标空间，逐空间任务在读取目标前过滤。 */
export async function transferringWorkspaceIds(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({
      source: workspaceTransfer.sourceWorkspaceId,
      target: workspaceTransfer.targetWorkspaceId,
    })
    .from(workspaceTransfer)
    .where(inArray(workspaceTransfer.status, [...WORKSPACE_TRANSFER_ACTIVE_STATUSES]))
  return new Set(rows.flatMap((row) => [row.source, row.target]))
}
