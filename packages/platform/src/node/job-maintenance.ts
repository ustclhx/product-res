import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  type Database,
  jobBatch,
  jobDeadLetter,
  jobMessage,
  jobQueue,
  jobStart,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, eq, inArray, isNull, lte, notExists } from 'drizzle-orm'

const minimumRetentionMs = 60 * 60 * 1_000
const terminalBatchStates = ['completed', 'failed']
const terminalMessageStates = ['acked', 'dead']
const terminalWorkflowStates = ['SUCCESS', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'CANCELLED']

export interface NodeQueueCleanupOptions {
  readonly now?: Date
  readonly terminalRetentionMs?: number
  readonly deadLetterRetentionMs?: number
  readonly startRetentionMs?: number
}

export interface NodeQueueCleanupSummary {
  messagesDeleted: number
  deadLettersDeleted: number
  batchesDeleted: number
  startsDeleted: number
  workflowsDeleted: number
  batchesRetained: number
}

function invalid(): AppError {
  return new AppError('QUEUE_RETENTION_INVALID', 'Invalid Node queue retention configuration')
}

function retention(value: number): number {
  if (!Number.isSafeInteger(value) || value < minimumRetentionMs) throw invalid()
  return value
}

function ratePeriod(policy: unknown): number {
  if (typeof policy !== 'object' || policy === null) throw invalid()
  if (!('rateLimit' in policy) || policy.rateLimit === undefined) return 0
  const rate = policy.rateLimit
  if (
    typeof rate !== 'object' ||
    rate === null ||
    !('periodMs' in rate) ||
    typeof rate.periodMs !== 'number' ||
    !Number.isSafeInteger(rate.periodMs) ||
    rate.periodMs < 1
  )
    throw invalid()
  return rate.periodMs
}

/** 只清理本模块 queue-batch journal；其他 workflow 和未来 event inbox 不在此入口范围内。 */
export async function cleanupNodeQueues(
  db: Database,
  options: NodeQueueCleanupOptions = {},
): Promise<NodeQueueCleanupSummary> {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw invalid()
  const terminalRetentionMs = retention(options.terminalRetentionMs ?? 7 * 24 * minimumRetentionMs)
  const deadLetterRetentionMs = retention(
    options.deadLetterRetentionMs ?? 30 * 24 * minimumRetentionMs,
  )
  const startRetentionMs = retention(options.startRetentionMs ?? minimumRetentionMs)
  const terminalCutoff = new Date(now.getTime() - terminalRetentionMs)
  const deadLetterCutoff = new Date(now.getTime() - deadLetterRetentionMs)
  const minimumCutoff = new Date(now.getTime() - minimumRetentionMs)
  const summary: NodeQueueCleanupSummary = {
    messagesDeleted: 0,
    deadLettersDeleted: 0,
    batchesDeleted: 0,
    startsDeleted: 0,
    workflowsDeleted: 0,
    batchesRetained: 0,
  }
  const queues = await db.select({ name: jobQueue.name }).from(jobQueue)
  for (const queue of queues) {
    await db.transaction(async (tx) => {
      // 与 claim/start 使用同一队列锁，清理不能改变正在计算的滑动启动额度。
      const [current] = await tx
        .select({ policy: jobQueue.policy })
        .from(jobQueue)
        .where(eq(jobQueue.name, queue.name))
        .for('update')
      if (!current) return
      const startCutoff = new Date(
        now.getTime() - Math.max(startRetentionMs, ratePeriod(current.policy)),
      )
      const batches = await tx
        .select({ id: jobBatch.id, finishedAt: jobBatch.finishedAt })
        .from(jobBatch)
        .where(
          and(
            eq(jobBatch.queue, queue.name),
            inArray(jobBatch.state, terminalBatchStates),
            lte(jobBatch.finishedAt, minimumCutoff),
          ),
        )
        .for('update')
      const cleanupMessages = async (batchId: string | null) => {
        const matchingBatch =
          batchId === null ? isNull(jobMessage.batchId) : eq(jobMessage.batchId, batchId)
        const deadMessages = tx
          .select({ id: jobMessage.id })
          .from(jobMessage)
          .where(
            and(
              eq(jobMessage.queue, queue.name),
              matchingBatch,
              inArray(jobMessage.state, terminalMessageStates),
              lte(jobMessage.finishedAt, terminalCutoff),
            ),
          )
        summary.deadLettersDeleted += (
          await tx
            .delete(jobDeadLetter)
            .where(
              and(
                eq(jobDeadLetter.queue, queue.name),
                lte(jobDeadLetter.createdAt, deadLetterCutoff),
                inArray(jobDeadLetter.messageId, deadMessages),
              ),
            )
            .returning({ id: jobDeadLetter.messageId })
        ).length
        summary.messagesDeleted += (
          await tx
            .delete(jobMessage)
            .where(
              and(
                eq(jobMessage.queue, queue.name),
                matchingBatch,
                inArray(jobMessage.state, terminalMessageStates),
                lte(jobMessage.finishedAt, terminalCutoff),
                notExists(
                  tx
                    .select({ id: jobDeadLetter.messageId })
                    .from(jobDeadLetter)
                    .where(eq(jobDeadLetter.messageId, jobMessage.id)),
                ),
              ),
            )
            .returning({ id: jobMessage.id })
        ).length
      }
      await cleanupMessages(null)
      for (const batch of batches) {
        const workflowID = `queue-batch:${batch.id}`
        const status = await DBOS.getWorkflowStatus(workflowID)
        // public delete 会一并删除 native 消息/事件；仅 owned queue journal 可使用它。
        // 缺失表示未发布或此前已清理；未知更新时间和任何 active 状态均保留。
        if (
          status &&
          (!terminalWorkflowStates.includes(status.status) ||
            status.workflowName !== 'product-res-queue-batch-v1' ||
            status.updatedAt === undefined ||
            !Number.isFinite(status.updatedAt) ||
            status.updatedAt > minimumCutoff.getTime())
        ) {
          summary.batchesRetained++
          continue
        }
        summary.startsDeleted += (
          await tx
            .delete(jobStart)
            .where(and(eq(jobStart.batchId, batch.id), lte(jobStart.startedAt, startCutoff)))
            .returning({ id: jobStart.id })
        ).length
        if (
          !batch.finishedAt ||
          batch.finishedAt > terminalCutoff ||
          (status && (status.updatedAt as number) > terminalCutoff.getTime())
        ) {
          summary.batchesRetained++
          continue
        }
        if (status) {
          // false 禁止递归删除其他模块的 child workflow；从不直接写第三方内部表。
          await DBOS.deleteWorkflow(workflowID, false)
          summary.workflowsDeleted++
        }
        await cleanupMessages(batch.id)
        const batchesDeleted = (
          await tx
            .delete(jobBatch)
            .where(
              and(
                eq(jobBatch.id, batch.id),
                inArray(jobBatch.state, terminalBatchStates),
                lte(jobBatch.finishedAt, terminalCutoff),
                notExists(
                  tx
                    .select({ id: jobMessage.id })
                    .from(jobMessage)
                    .where(eq(jobMessage.batchId, jobBatch.id)),
                ),
                notExists(
                  tx
                    .select({ id: jobStart.id })
                    .from(jobStart)
                    .where(eq(jobStart.batchId, jobBatch.id)),
                ),
              ),
            )
            .returning({ id: jobBatch.id })
        ).length
        summary.batchesDeleted += batchesDeleted
        if (!batchesDeleted) summary.batchesRetained++
      }
    })
  }
  // 只输出计数，不输出 inbox body、SDK inputs/output/error 或任意原始错误。
  log.info('platform.queue.cleaned', { ...summary })
  return summary
}
