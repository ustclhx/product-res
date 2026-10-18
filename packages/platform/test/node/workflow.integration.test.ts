import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDb, jobWorkflowEvent, jobWorkflowWait } from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { migrateNodeJobEngine } from '../../src/node/job-engine-migrate.ts'
import type { Workflow, WorkflowInstance, WorkflowState } from '../../src/workflow.ts'
import {
  completed,
  eventually,
  prepareWorkflowTestTables,
  type WorkflowWorker,
  workflowState,
  workflowWorker,
} from './workflow.helpers.ts'

const url = process.env.TEST_JOB_DATABASE_URL
const migratorUrl = process.env.TEST_JOB_MIGRATOR_URL
const readonlyUrl = process.env.TEST_JOB_READONLY_DATABASE_URL
if (!url || !migratorUrl || !readonlyUrl)
  throw new Error('Isolated workflow database variables required')
const db = createDb(url, { max: 3 })
const readonly = createDb(readonlyUrl, { max: 1 })
const runId = randomUUID()
const children = new Set<WorkflowWorker>()
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-integration-'))
  await prepareWorkflowTestTables(migratorUrl)
  await migrateNodeJobEngine({
    databaseUrl: migratorUrl,
    applicationRole: 'app',
    readonlyRole: 'readonly',
  })
})
afterAll(async () => {
  await Promise.all([...children].map((child) => child.stop()))
  await Promise.all([db.close(), readonly.close()])
  await rm(directory, { recursive: true, force: true })
})
afterEach(async () => {
  // 即使当前断言失败也停止其 worker，不能让缺少后续 handler 的实例领取下一用例。
  await Promise.all([...children].map((child) => child.stop()))
  children.clear()
})
async function launch(name = `test-${randomUUID()}`, executorId = randomUUID()) {
  const child = workflowWorker({ name, executorId, runId, ownershipDirectory: directory })
  children.add(child)
  await child.wait('ready')
  return { child, name, executorId }
}
function nativeId(name: string, id: string) {
  return `workflow:${Buffer.from(name).toString('base64url')}:${Buffer.from(id).toString('base64url')}`
}
async function create(
  child: WorkflowWorker,
  params: Record<string, unknown>,
  id: string = randomUUID(),
) {
  await child.request('create', { id, params: { key: id, ...params } })
  return id
}
async function counts(key: string) {
  return db.execute<{
    step: string
    count: number
  }>(sql`SELECT step,count(*)::int AS count FROM test_workflow_attempt
    WHERE run_id=${runId} AND key=${key} GROUP BY step ORDER BY step`)
}
async function effectCount(key: string, step?: string) {
  const rows =
    step === undefined
      ? await db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM test_workflow_effect WHERE run_id=${runId} AND key=${key}`,
        )
      : await db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM test_workflow_effect WHERE run_id=${runId} AND key=${key} AND step=${step}`,
        )
  return rows[0]?.count ?? 0
}
async function waits(name: string, id: string) {
  return db
    .select()
    .from(jobWorkflowWait)
    .where(eq(jobWorkflowWait.workflowId, nativeId(name, id)))
}
async function events(name: string, id: string) {
  return db
    .select()
    .from(jobWorkflowEvent)
    .where(eq(jobWorkflowEvent.workflowId, nativeId(name, id)))
}
// 固定5.2.11只读native sleep日志，确认原deadline已经持久化后才注入退出。
async function sleepCheckpoint(name: string, id: string, count = 1) {
  return eventually(
    async () =>
      db.execute<{ output: string; function_id: number }>(sql`SELECT output,function_id
    FROM dbos.operation_outputs WHERE workflow_uuid=${nativeId(name, id)} AND function_name='DBOS.sleep'
    ORDER BY function_id`),
    (rows) => rows.length >= count,
  )
}

// 编译期验收：调用方只有正式中立合同，事件timestamp必须Date。
async function formalWorkflowContract(binding: Workflow<{ taskId: string }, { done: boolean }>) {
  const instance: WorkflowInstance<{ done: boolean }> = await binding.create({
    params: { taskId: '业务:task' },
  })
  const state: WorkflowState<{ done: boolean }> = await instance.status()
  await instance.sendEvent({ type: 'media-done', payload: { ready: true } })
  await instance.terminate()
  return state
}
void formalWorkflowContract

describe('Node durable workflows on real PostgreSQL', () => {
  it('recovers a JSON-null event committed to the wait journal before the native checkpoint without consuming twice', async () => {
    const launched = await launch()
    const id = await create(launched.child, { mode: 'event-checkpoint' })
    await launched.child.request('event', { id, type: 'early', payload: null })
    await launched.child.wait('event-consumed-before-checkpoint')
    const [originalEvent] = await events(launched.name, id)
    const [originalWait] = await waits(launched.name, id)
    expect(originalEvent?.consumedAt).not.toBeNull()
    expect(originalWait?.state).toBe('completed')
    await launched.child.stop('SIGKILL')
    const recovered = await launch(launched.name, launched.executorId)
    expect(await completed(recovered.child, id)).toEqual({
      payload: null,
      timestamp: originalEvent?.createdAt.toISOString(),
    })
    expect(await events(launched.name, id)).toHaveLength(1)
    expect((await waits(launched.name, id))[0]?.result).toEqual(originalWait?.result)
    expect(await effectCount(id, 'journal-crash')).toBe(1)
    await recovered.child.request('stop-receiving')
    await expect(create(recovered.child, { mode: 'basic' })).rejects.toMatchObject({
      code: 'WORKFLOW_STOPPING',
    })
    expect((await workflowState(recovered.child, id)).status).toBe('completed')
  })

  it('keeps retry attempts and their original wakeup across restart and runs the media submit/persist retry policies in real milliseconds', async () => {
    const launched = await launch()
    const id = await create(launched.child, {
      mode: 'retry',
      failures: 3,
      limit: 3,
      delayMs: 1_000,
      backoff: 'linear',
    })
    const [originalSleep] = await sleepCheckpoint(launched.name, id)
    await launched.child.stop('SIGKILL')
    const recovered = await launch(launched.name, launched.executorId)
    expect(await completed(recovered.child, id)).toEqual({ succeeded: true })
    expect(await counts(id)).toEqual([{ step: 'retry', count: 4 }])
    expect((await sleepCheckpoint(launched.name, id))[0]?.output).toEqual(originalSleep?.output)
    const submit = await create(recovered.child, {
      mode: 'retry',
      failures: 1,
      limit: 1,
      delayMs: 10_000,
      backoff: 'exponential',
      timeoutMs: 120_000,
    })
    const persist = await create(recovered.child, {
      mode: 'retry',
      failures: 3,
      limit: 3,
      delayMs: 10_000,
      backoff: 'linear',
      timeoutMs: 120_000,
    })
    expect(await completed(recovered.child, submit, 90_000)).toEqual({ succeeded: true })
    expect(await completed(recovered.child, persist, 90_000)).toEqual({ succeeded: true })
    for (const [key, expected] of [
      [submit, [10_000]],
      [persist, [10_000, 20_000, 30_000]],
    ] as const) {
      const attempts = await db.execute<{ started_at: string }>(
        sql`SELECT started_at FROM test_workflow_attempt WHERE run_id=${runId} AND key=${key} ORDER BY started_at`,
      )
      expect(attempts).toHaveLength(expected.length + 1)
      for (const [index, delayMs] of expected.entries()) {
        const elapsed =
          new Date(attempts[index + 1]?.started_at ?? '').getTime() -
          new Date(attempts[index]?.started_at ?? '').getTime()
        expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10)
        expect(elapsed).toBeLessThan(delayMs + 1_000)
      }
    }
  }, 100_000)

  it('preserves arbitrary business IDs and duplicate identity without repeating effects; engine success stays independent of business failure', async () => {
    const { child } = await launch()
    const id = `采集:客户/商品:${randomUUID()}`
    await create(child, { mode: 'basic' }, id)
    const output = await completed(child, id)
    expect(output).toEqual({ businessStatus: 'failed', total: 10 })
    expect(await child.request('get', { id })).toMatchObject({ id })
    await create(child, { mode: 'failure' }, id)
    expect(await completed(child, id)).toEqual(output)
    expect(await counts(id)).toEqual([
      { step: 'finish', count: 1 },
      { step: 'list', count: 1 },
    ])
    expect(await effectCount(id)).toBe(1)
    const generated = await child.request('create', {
      params: { key: randomUUID(), mode: 'basic' },
    })
    expect(generated.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    await completed(child, generated.id as string)
    await expect(child.request('get', { id: randomUUID() })).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    })
    await expect(
      child.request('event', { id, type: 'early', payload: null }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TERMINAL' })
    await expect(
      child.request('event', { id: randomUUID(), type: 'early', payload: null }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' })
    const failed = await create(child, { mode: 'failure' })
    expect(
      await eventually(
        () => workflowState(child, failed),
        (state) => state.status === 'failed',
      ),
    ).toEqual({
      status: 'failed',
      error: { name: 'WorkflowError', message: 'Workflow execution failed' },
    })
    const terminated = await create(child, { mode: 'sleep', sleepMs: 60_000 })
    await child.wait('sleep-entered')
    await child.request('terminate', { id: terminated })
    expect((await workflowState(child, terminated)).status).toBe('terminated')
    await expect(
      child.request('event', { id: terminated, type: 'early', payload: null }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TERMINAL' })
    expect(child.output()).not.toContain('SECRET_WORKFLOW_FAILURE')
    await child.stop()
  })

  it('rejects non-JSON params, event payloads, step results and workflow outputs at persistence boundaries', async () => {
    const { child } = await launch()
    const active = await create(child, { mode: 'sleep', sleepMs: 60_000 })
    for (const invalid of [
      'date',
      'nan',
      'bigint',
      'undefined',
      'binary',
      'circular',
      'function',
    ]) {
      await expect(child.request('invalid-params', { invalid })).rejects.toMatchObject({
        code: 'WORKFLOW_INVALID_JSON',
      })
      await expect(child.request('invalid-event', { id: active, invalid })).rejects.toMatchObject({
        code: 'WORKFLOW_INVALID_JSON',
      })
    }
    for (const mode of ['invalid-step', 'invalid-output']) {
      const id = await create(child, { mode, invalid: 'date' })
      expect(
        (
          await eventually(
            () => workflowState(child, id),
            (state) => state.status === 'failed',
          )
        ).status,
      ).toBe('failed')
    }
    await child.request('terminate', { id: active })
    await child.stop()
  })

  it('buffers queued and sleeping events by type FIFO, consumes once, and restores Date timestamps after restart', async () => {
    const launched = await launch()
    let { child } = launched
    const id = await create(child, { mode: 'fifo', sleepMs: 1_500 })
    await child.request('event', {
      id,
      type: 'a',
      payload: { ordinal: 1, privateContent: 'SECRET_EARLY_EVENT' },
    })
    await child.request('event', { id, type: 'a', payload: { ordinal: 2 } })
    await child.request('event', { id, type: 'b', payload: { ordinal: 3 } })
    const stored = await events(launched.name, id)
    expect(stored).toHaveLength(3)
    await sleepCheckpoint(launched.name, id)
    await child.stop('SIGKILL')
    child = (await launch(launched.name, launched.executorId)).child
    const output = (await completed(child, id)) as {
      received: { type: string; payload: { ordinal: number }; timestamp: string; date: boolean }[]
      timedOut: boolean
    }
    expect(output.received.map((event) => [event.type, event.payload.ordinal, event.date])).toEqual(
      [
        ['b', 3, true],
        ['a', 1, true],
        ['a', 2, true],
      ],
    )
    for (const event of output.received) {
      const original = stored.find(
        (row) =>
          row.type === event.type &&
          (row.payload as { ordinal: number }).ordinal === event.payload.ordinal,
      )
      expect(event.timestamp).toBe(original?.createdAt.toISOString())
    }
    expect(output.timedOut).toBe(true)
    expect((await events(launched.name, id)).every((event) => event.consumedAt !== null)).toBe(true)
    expect(child.output()).not.toContain('SECRET_EARLY_EVENT')
    await child.stop()
  })

  it('keeps the original wait deadline and refuses an event arriving after it while the executor is stopped', async () => {
    const launched = await launch()
    const id = await create(launched.child, { mode: 'wait', timeoutMs: 1_500 })
    const [original] = await eventually(
      () => waits(launched.name, id),
      (rows) => rows.length === 1,
    )
    expect(original).toBeDefined()
    await launched.child.stop('SIGKILL')
    await delay(Math.max(0, (original?.deadline.getTime() ?? 0) - Date.now()) + 100)
    // 第二executor仅负责发送；原实例直到原executor恢复才重放。
    const sender = await launch(launched.name)
    await sender.child.request('event', { id, type: 'resume', payload: { late: true } })
    await sender.child.stop()
    const recovered = await launch(launched.name, launched.executorId)
    expect(await completed(recovered.child, id)).toEqual({ timedOut: true })
    const [after] = await waits(launched.name, id)
    expect(after?.deadline).toEqual(original?.deadline)
    expect(after?.state).toBe('timeout')
    expect((await events(launched.name, id))[0]?.consumedAt).toBeNull()
    expect(await counts(id)).toEqual([{ step: 'list', count: 1 }])
    await recovered.child.stop()
  })

  it('persists retry attempts and exact linear/constant/exponential delay policy; limit excludes the first attempt', async () => {
    const { child } = await launch()
    for (const [backoff, expected] of [
      ['linear', [100, 200, 300]],
      ['constant', [100, 100, 100]],
      ['exponential', [100, 200, 400]],
    ] as const) {
      const id = await create(child, {
        mode: 'retry',
        backoff,
        failures: 3,
        limit: 3,
        delayMs: 100,
      })
      expect(await completed(child, id)).toEqual({ succeeded: true })
      const attempts = await db.execute<{
        started_at: string
      }>(sql`SELECT started_at FROM test_workflow_attempt
        WHERE run_id=${runId} AND key=${id} ORDER BY started_at`)
      expect(attempts).toHaveLength(4)
      for (const [index, milliseconds] of expected.entries()) {
        const actual =
          new Date(attempts[index + 1]?.started_at ?? '').getTime() -
          new Date(attempts[index]?.started_at ?? '').getTime()
        expect(actual).toBeGreaterThanOrEqual(milliseconds - 10)
        expect(actual).toBeLessThan(milliseconds + 1_000)
      }
    }
    // 原media submit/persist策略，短delay保留次数和退避含义；120000ms timeout仍用原配置。
    const submit = await create(child, {
      mode: 'retry',
      backoff: 'exponential',
      failures: 2,
      limit: 1,
      delayMs: 100,
      timeoutMs: 120_000,
    })
    expect(
      (
        await eventually(
          () => workflowState(child, submit),
          (state) => state.status === 'failed',
        )
      ).status,
    ).toBe('failed')
    expect(await counts(submit)).toEqual([{ step: 'retry', count: 2 }])
    await child.stop()
  })

  it('allows NonRetryable failure settlement once and reports timeout safely while an uncooperative callback can still finish', async () => {
    const { child } = await launch()
    const id = await create(child, { mode: 'nonretryable' })
    expect(await completed(child, id)).toEqual({
      businessStatus: 'failed',
      holdReleased: true,
      carriedCode: 'FIXTURE_PROVIDER_REJECTED',
    })
    expect(await counts(id)).toEqual([
      { step: 'settlement', count: 1 },
      { step: 'submit', count: 1 },
    ])
    expect(await effectCount(id, 'release-hold')).toBe(1)
    const timeout = await create(child, { mode: 'timeout' })
    expect(await completed(child, timeout)).toEqual({ timedOut: true })
    await eventually(
      () => effectCount(timeout, 'uncooperative-callback'),
      (value) => value === 1,
    )
    expect(await counts(timeout)).toEqual([{ step: 'slow', count: 1 }])
    expect(child.output()).not.toContain('SECRET_SUBMISSION_UNCERTAIN')
    await child.stop()
  })

  it('drains gracefully with unfinished sleep retained, reuses successful checkpoints and retries a side effect before checkpoint idempotently', async () => {
    const launched = await launch()
    const sleepId = await create(launched.child, { mode: 'sleep', sleepMs: 5_000 })
    const [checkpoint] = await sleepCheckpoint(launched.name, sleepId)
    const deadline = Number(JSON.parse(checkpoint?.output as string))
    await delay(500)
    await launched.child.stop()
    const [retained] = await db.execute<{ status: string }>(
      sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid=${nativeId(launched.name, sleepId)}`,
    )
    expect(retained?.status).toBe('PENDING')
    const recovered = await launch(launched.name, launched.executorId)
    expect(await completed(recovered.child, sleepId)).toEqual({
      businessStatus: 'failed',
      total: 10,
    })
    const [after] = await sleepCheckpoint(launched.name, sleepId)
    expect(after?.output).toBe(checkpoint?.output)
    expect(Date.now()).toBeGreaterThanOrEqual(deadline)
    expect(Date.now()).toBeLessThan(deadline + 1_000)
    expect(await counts(sleepId)).toEqual([
      { step: 'finish', count: 1 },
      { step: 'list', count: 1 },
    ])
    const crashId = await create(recovered.child, { mode: 'crash-window' })
    await recovered.child.wait('effect-before-checkpoint')
    await recovered.child.stop('SIGKILL')
    const second = await launch(launched.name, launched.executorId)
    expect(await completed(second.child, crashId)).toEqual({ once: true })
    expect(await counts(crashId)).toEqual([{ step: 'effect', count: 2 }])
    expect(await effectCount(crashId)).toBe(1)
    await second.child.stop()
  })

  it('restricts readonly access and only removes terminal event data after the minimum 60-minute retention', async () => {
    const { child, name } = await launch()
    const active = await create(child, { mode: 'sleep', sleepMs: 60_000 })
    await child.request('event', {
      id: active,
      type: 'early',
      payload: { privateContent: 'SECRET_RETAINED_EVENT' },
    })
    await readonly.execute(
      sql`SELECT id,sequence,workflow_id,type,created_at,consumed_at FROM job_engine.workflow_event LIMIT 1`,
    )
    await readonly.execute(
      sql`SELECT id,workflow_id,name,type,deadline,state FROM job_engine.workflow_wait LIMIT 1`,
    )
    await expect(
      readonly.execute(sql`SELECT payload FROM job_engine.workflow_event LIMIT 1`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(
      readonly.execute(sql`SELECT result FROM job_engine.workflow_wait LIMIT 1`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(
      child.request('cleanup', { terminalRetentionMs: 3_599_999 }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RETENTION_INVALID' })
    await child.request('cleanup', {
      now: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      terminalRetentionMs: 3_600_000,
    })
    expect(await events(name, active)).toHaveLength(1)
    await child.request('terminate', { id: active })
    const boundary = Date.now()
    await child.request('cleanup', {
      now: new Date(boundary + 3_599_000).toISOString(),
      terminalRetentionMs: 3_600_000,
    })
    expect(await events(name, active)).toHaveLength(1)
    await child.request('cleanup', {
      now: new Date(boundary + 3_601_000).toISOString(),
      terminalRetentionMs: 3_600_000,
    })
    expect(await events(name, active)).toHaveLength(0)
    expect(child.output()).not.toContain('SECRET_RETAINED_EVENT')
    await child.stop()
  })

  it.skipIf(process.env.TEST_WORKFLOW_LONG !== '1')(
    'runs a real 61-minute collection pipeline with same-version sleep/wait restarts and a 60+minute early event',
    async () => {
      const startedAt = new Date()
      const launched = await launch()
      let { child } = launched
      // 先快速完成第一段重启/wait故障注入，再用真实长sleep验证60+分钟事件，减少迟发现故障。
      const id = await create(child, {
        mode: 'pipeline',
        sleepMs: 2_000,
        secondSleepMs: 3_661_000,
        timeoutMs: 60_000,
      })
      await child.request('event', { id, type: 'early', payload: { ready: true } })
      const [early] = await events(launched.name, id)
      const firstSleep = await sleepCheckpoint(launched.name, id)
      await child.stop('SIGKILL')
      child = (await launch(launched.name, launched.executorId)).child
      console.info(
        JSON.stringify({
          event: 'workflow.long.sleep-restart',
          utc: new Date().toISOString(),
          version: 'workflow-integration-v1',
          businessId: id,
        }),
      )
      await child.wait('wait-entered', 30_000)
      const [originalWait] = await eventually(
        () => waits(launched.name, id),
        (rows) => rows.some((row) => row.name === 'deadline'),
      )
      await child.stop('SIGKILL')
      child = (await launch(launched.name, launched.executorId)).child
      await child.request('event', { id, type: 'resume', payload: null })
      await child.wait('second-sleep-entered')
      // first sleep + 五次限流sleep + second sleep，全部已有持久原唤醒时刻。
      const beforeSecondRestart = await sleepCheckpoint(launched.name, id, 7)
      const beforeCounts = await counts(id)
      await child.stop('SIGKILL')
      child = (await launch(launched.name, launched.executorId)).child
      console.info(
        JSON.stringify({
          event: 'workflow.long.checkpoint-restart',
          utc: new Date().toISOString(),
          completedCallbacks: beforeCounts,
        }),
      )
      const output = (await completed(child, id, 3_800_000)) as {
        total: number
        date: boolean
        eventTimestamp: string
      }
      const endedAt = new Date()
      const elapsedMs = endedAt.getTime() - startedAt.getTime()
      const earlyAgeMs = endedAt.getTime() - (early?.createdAt.getTime() ?? endedAt.getTime())
      expect(elapsedMs).toBeGreaterThan(3_600_000)
      expect(elapsedMs).toBeLessThan(7_200_000)
      expect(earlyAgeMs).toBeGreaterThan(3_600_000)
      expect(output).toEqual({
        total: 10,
        date: true,
        eventTimestamp: early?.createdAt.toISOString(),
      })
      const finalCounts = await counts(id)
      expect(finalCounts).toHaveLength(18)
      expect(finalCounts.every((row) => row.count === 1)).toBe(true)
      expect(await effectCount(id)).toBe(15)
      const finalSleeps = await sleepCheckpoint(launched.name, id, 7)
      expect(finalSleeps).toEqual(beforeSecondRestart)
      expect(finalSleeps[0]).toEqual(firstSleep[0])
      const [finalWait] = await db
        .select()
        .from(jobWorkflowWait)
        .where(
          and(
            eq(jobWorkflowWait.workflowId, nativeId(launched.name, id)),
            eq(jobWorkflowWait.name, 'deadline'),
          ),
        )
      expect(finalWait?.deadline).toEqual(originalWait?.deadline)
      expect(await child.request('get', { id })).toMatchObject({ id })
      console.info(
        JSON.stringify({
          event: 'workflow.long.evidence',
          version: 'workflow-integration-v1',
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          elapsedMs,
          earlyAgeMs,
          businessId: id,
          callbacks: finalCounts,
          effects: 15,
          waitDeadline: finalWait?.deadline.toISOString(),
        }),
      )
      await child.stop()
    },
    4_000_000,
  )
})
