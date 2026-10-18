import { AppError } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import type { DatabaseTransaction } from '../queue.ts'

export const terminalNativeWorkflowStates = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
]

/** 固定 DBOS 5.2.11 的只读锁定耦合：升级须复验列名与终态写入同一行锁的行为。 */
export async function lockNativeWorkflow(tx: DatabaseTransaction, workflowId: string) {
  const [row] = await tx.execute<{ status: string; name: string; updated_at: number }>(sql`
    SELECT status, name, updated_at FROM dbos.workflow_status
    WHERE workflow_uuid = ${workflowId} FOR UPDATE`)
  if (!row) throw new AppError('WORKFLOW_NOT_FOUND', 'Workflow instance not found', { status: 404 })
  return row
}

export function assertNativeWorkflowActive(status: string): void {
  if (terminalNativeWorkflowStates.includes(status))
    throw new AppError('WORKFLOW_TERMINAL', 'Workflow instance has ended', { status: 409 })
}

/** 原始驱动/SDK 异常可能含连接信息；API 边界只返回稳定平台错误。 */
export async function workflowOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('WORKFLOW_ENGINE_UNAVAILABLE', 'Workflow engine is unavailable', {
      status: 503,
    })
  }
}
