import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { type Database, jobWorkflowEvent, jobWorkflowWait } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import type { JsonValue, WorkflowStepEvent } from '../workflow.ts'
import type { NodeJobEngine } from './job-engine.ts'
import { jsonValue } from './workflow-json.ts'
import {
  assertNativeWorkflowActive,
  lockNativeWorkflow,
  terminalNativeWorkflowStates,
} from './workflow-native.ts'

export function validateEventType(type: string): void {
  if (typeof type !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(type))
    throw new AppError('WORKFLOW_INVALID_EVENT_TYPE', 'Invalid workflow event type')
}

export async function sendNodeWorkflowEvent(
  engine: NodeJobEngine,
  workflowId: string,
  event: { type: string; payload: JsonValue },
): Promise<void> {
  validateEventType(event.type)
  const payload = jsonValue(event.payload)
  await engine.assertOwnership()
  await engine.database.transaction(async (tx) => {
    const native = await lockNativeWorkflow(tx, workflowId)
    assertNativeWorkflowActive(native.status)
    await tx.insert(jobWorkflowEvent).values({
      workflowId,
      type: event.type,
      // Drizzle 对 JS null 跳过 JSON codec；显式编码使合法 JSON null 不成为 SQL NULL。
      payload: sql`${JSON.stringify(payload)}::jsonb`,
      // 等待期限以数据库时钟判定；事务开始时间可能早于锁等待，不能用 now()。
      createdAt: sql`clock_timestamp()`,
    })
  })
}

type PersistedEvent = { type: string; payload: JsonValue; timestamp: string }

export async function waitForNodeWorkflowEvent(
  engine: NodeJobEngine,
  workflowId: string,
  name: string,
  options: { type: string; timeoutMs: number },
): Promise<WorkflowStepEvent<JsonValue>> {
  validateEventType(options.type)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    throw new AppError('WORKFLOW_INVALID_STEP', 'Invalid workflow wait timeout')
  // 自有结果日志保护消费与 native checkpoint 之间的退出窗口；轮询 timer 不承担持久状态。
  const result = await DBOS.runStep(
    async () => {
      for (;;) {
        await engine.assertOwnership()
        const outcome = await engine.database.transaction(async (tx) => {
          const native = await lockNativeWorkflow(tx, workflowId)
          assertNativeWorkflowActive(native.status)
          await tx
            .insert(jobWorkflowWait)
            .values({
              workflowId,
              name,
              type: options.type,
              deadline: sql`clock_timestamp() + ${options.timeoutMs} * interval '1 millisecond'`,
            })
            .onConflictDoNothing()
          const [wait] = await tx
            .select()
            .from(jobWorkflowWait)
            .where(and(eq(jobWorkflowWait.workflowId, workflowId), eq(jobWorkflowWait.name, name)))
            .for('update')
          if (!wait || wait.type !== options.type)
            throw new AppError('WORKFLOW_STEP_CHANGED', 'Workflow wait definition changed')
          if (wait.state === 'completed')
            return { state: 'completed', result: wait.result as PersistedEvent }
          if (wait.state === 'timeout') return { state: 'timeout' }
          const [event] = await tx
            .select()
            .from(jobWorkflowEvent)
            .where(
              and(
                eq(jobWorkflowEvent.workflowId, workflowId),
                eq(jobWorkflowEvent.type, options.type),
                isNull(jobWorkflowEvent.consumedAt),
                lte(jobWorkflowEvent.createdAt, wait.deadline),
              ),
            )
            .orderBy(asc(jobWorkflowEvent.sequence))
            .limit(1)
            .for('update')
          if (event) {
            const result: PersistedEvent = {
              type: event.type,
              payload: jsonValue(event.payload),
              timestamp: event.createdAt.toISOString(),
            }
            await tx
              .update(jobWorkflowEvent)
              .set({ consumedAt: sql`clock_timestamp()` })
              .where(eq(jobWorkflowEvent.id, event.id))
            await tx
              .update(jobWorkflowWait)
              .set({ state: 'completed', result, finishedAt: sql`clock_timestamp()` })
              .where(eq(jobWorkflowWait.id, wait.id))
            return { state: 'completed', result }
          }
          const [clock] = await tx.execute<{ expired: boolean }>(
            sql`SELECT clock_timestamp() >= ${wait.deadline.toISOString()}::timestamptz AS expired`,
          )
          if (clock?.expired) {
            await tx
              .update(jobWorkflowWait)
              .set({ state: 'timeout', finishedAt: sql`clock_timestamp()` })
              .where(eq(jobWorkflowWait.id, wait.id))
            return { state: 'timeout' }
          }
          return { state: 'waiting' }
        })
        if (outcome.state === 'completed') return { event: outcome.result as PersistedEvent }
        if (outcome.state === 'timeout') return { event: null }
        await delay(100)
      }
    },
    { name: `wait:${name}` },
  )
  if (!result.event)
    throw new AppError('WORKFLOW_EVENT_TIMEOUT', 'Workflow event wait timed out', { status: 408 })
  return {
    type: result.event.type,
    payload: result.event.payload,
    timestamp: new Date(result.event.timestamp),
  }
}

/** 清理只涉及自有事件/wait日志，绝不删除 native journal、消息或第三方表。 */
export async function cleanupNodeWorkflowEvents(
  db: Database,
  options: { now?: Date; terminalRetentionMs?: number } = {},
) {
  const retention = options.terminalRetentionMs ?? 7 * 86_400_000
  const now = options.now ?? new Date()
  if (!Number.isSafeInteger(retention) || retention < 3_600_000 || !Number.isFinite(now.getTime()))
    throw new AppError('WORKFLOW_RETENTION_INVALID', 'Invalid workflow event retention')
  const cutoff = new Date(now.getTime() - retention)
  const summary = { eventsDeleted: 0, waitsDeleted: 0 }
  const ids = await db
    .selectDistinct({ workflowId: jobWorkflowEvent.workflowId })
    .from(jobWorkflowEvent)
  const waits = await db
    .selectDistinct({ workflowId: jobWorkflowWait.workflowId })
    .from(jobWorkflowWait)
  for (const workflowId of new Set([...ids, ...waits].map((row) => row.workflowId))) {
    await db.transaction(async (tx) => {
      // 缺失 native 归属也不能作为删除依据。人工 resume 与清理须运维互斥。
      const native = await tx.execute<{ status: string; updated_at: number; name: string }>(
        sql`SELECT status,updated_at,name FROM dbos.workflow_status WHERE workflow_uuid=${workflowId} FOR UPDATE`,
      )
      const state = native[0]
      if (
        !state ||
        !workflowId.startsWith('workflow:') ||
        !state.name.startsWith('product-res-workflow:') ||
        !terminalNativeWorkflowStates.includes(state.status) ||
        !Number.isFinite(Number(state.updated_at)) ||
        Number(state.updated_at) > cutoff.getTime()
      )
        return
      summary.eventsDeleted += (
        await tx
          .delete(jobWorkflowEvent)
          .where(
            and(
              eq(jobWorkflowEvent.workflowId, workflowId),
              lte(jobWorkflowEvent.createdAt, cutoff),
            ),
          )
          .returning({ id: jobWorkflowEvent.id })
      ).length
      // waiting 日志在终止后仍有原 deadline；删除以其创建时间和实例终态保留期共同约束。
      summary.waitsDeleted += (
        await tx
          .delete(jobWorkflowWait)
          .where(
            and(eq(jobWorkflowWait.workflowId, workflowId), lte(jobWorkflowWait.createdAt, cutoff)),
          )
          .returning({ id: jobWorkflowWait.id })
      ).length
    })
  }
  log.info('platform.workflow.events_cleaned', summary)
  return summary
}
