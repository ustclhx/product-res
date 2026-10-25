import {
  type Database,
  WORKSPACE_TRANSFER_ACTIVE_STATUSES,
  workspaceTransfer,
} from '@product-res/db'
import { eq, sql } from 'drizzle-orm'
import { type Tx, xactLock } from './common.ts'

/**
 * 流转 Workflow 的跨应用约定（tasks 4.1）：web 投递、jobs 执行，两边共享名称、参数与内部鉴权。
 * 实例 id 为流转 id；“重试续跑”另起实例时用 `<流转 id>-<新 uuid>`（引擎步骤幂等，并发实例安全）。
 */

/** Node 引擎中的注册名；步骤顺序变化时升版本号，旧实例按原版本 handler 完成 */
export const WORKSPACE_TRANSFER_WORKFLOW = 'workspace-transfer-v1'

export type WorkspaceTransferWorkflowParams = { transferId: string; requestId?: string }

const encoder = new TextEncoder()

/**
 * Node 目标中 web → jobs 内部接口的 Bearer：由两边都已配置的 BETTER_AUTH_SECRET 经 HMAC 派生，
 * 不新增部署密钥，也不在内网明文传输认证主密钥。
 */
export async function transferWorkflowToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('workflow:workspace-transfer'),
  )
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const startLock = (transferId: string) => `transfer-start:${transferId}`

/**
 * 发起事务内、投递实例之前调用：持有到发起事务结束。Workflow 的 load 步骤先取同一把锁，
 * 因此读到的结果是发起事务提交（或回滚）之后的最终状态，慢提交不会被误判为不存在。
 */
export async function holdTransferStart(tx: Tx, transferId: string): Promise<void> {
  await xactLock(tx, startLock(transferId))
}

export interface TransferHead {
  readonly status: string
  readonly kind: string
  readonly source: string
  readonly target: string
  readonly requestedBy: string
  readonly errorCode: string | null
  readonly workflowInstanceId: string | null
}

/** 等发起事务结束后读取流转；返回 null 表示发起事务已回滚（记录确实不存在） */
export async function loadTransferAfterStart(
  db: Database,
  transferId: string,
): Promise<TransferHead | null> {
  return db.transaction(async (tx) => {
    await holdTransferStart(tx, transferId)
    const [row] = await tx
      .select({
        status: workspaceTransfer.status,
        kind: workspaceTransfer.kind,
        source: workspaceTransfer.sourceWorkspaceId,
        target: workspaceTransfer.targetWorkspaceId,
        requestedBy: workspaceTransfer.requestedBy,
        errorCode: workspaceTransfer.errorCode,
        workflowInstanceId: workspaceTransfer.workflowInstanceId,
      })
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, transferId))
    return row ?? null
  })
}

/**
 * jobs 内部接口创建实例前的校验（降低令牌重放的影响）：流转须存在且处于进行中；
 * 发起事务尚未提交（仍持有发起锁）时记录不可见，此时放行——只有正在发起的事务会持有该锁。
 */
export async function transferAcceptsInstance(db: Database, transferId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${startLock(transferId)}, 0)) as ok`,
    )) as unknown as { ok: boolean }[]
    if (!lock?.ok) return true
    const [row] = await tx
      .select({ status: workspaceTransfer.status })
      .from(workspaceTransfer)
      .where(eq(workspaceTransfer.id, transferId))
    return (
      row !== undefined &&
      (WORKSPACE_TRANSFER_ACTIVE_STATUSES as readonly string[]).includes(row.status)
    )
  })
}
