import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDb, jobSchedule, jobScheduleRun, recordLastCronAt, setting } from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { migrateNodeJobEngine } from '../../src/node/job-engine-migrate.ts'
import type { createNodeScheduler } from '../../src/node/scheduler.ts'
import type { Scheduler } from '../../src/scheduler.ts'
import { until } from './job-queue.helpers.ts'
import {
  prepareSchedulerTestTables,
  type SchedulerWorker,
  type SchedulerWorkerConfig,
  schedulerAttempts,
  schedulerEffects,
  schedulerWorker,
} from './scheduler.helpers.ts'

// 编译检查正式中立契约；运行时验证由隔离进程完成，避免 DBOS singleton 相互污染。
const schedulerContract: (value: ReturnType<typeof createNodeScheduler>) => Scheduler = (value) =>
  value
void schedulerContract
const url = process.env.TEST_JOB_DATABASE_URL
const migratorUrl = process.env.TEST_JOB_MIGRATOR_URL
if (!url || !migratorUrl) throw new Error('Isolated job database variables required')
const db = createDb(url, { max: 3 })
const runId = randomUUID()
const children = new Set<SchedulerWorker>()
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scheduler-lifecycle-'))
  await prepareSchedulerTestTables(migratorUrl)
  // 业务 schema 由外部 migrator 准备；测试只运行原生引擎迁移/权限与独立效果表 DDL。
  await migrateNodeJobEngine({
    databaseUrl: migratorUrl,
    applicationRole: 'app',
    readonlyRole: 'readonly',
  })
})
afterEach(async () => {
  await Promise.all([...children].map((child) => child.stop()))
  children.clear()
})
afterAll(async () => {
  await db.close()
  await rm(directory, { recursive: true, force: true })
})
const id = () => `schedule-${randomUUID()}`
const seconds = (scheduleId: string, missedRun: 'skip' | 'once' = 'skip') => ({
  id: scheduleId,
  cron: '* * * * * *',
  timeZone: 'UTC',
  missedRun,
})
function spawn(
  schedules: SchedulerWorkerConfig['schedules'],
  prepareAt?: Date,
  executorId: string = randomUUID(),
  fault?: SchedulerWorkerConfig['fault'],
) {
  const child = schedulerWorker({
    runId,
    executorId,
    ownershipDirectory: directory,
    schedules,
    ...(fault ? { fault } : {}),
    ...(prepareAt ? { prepareAt: prepareAt.toISOString() } : {}),
  })
  children.add(child)
  return child
}
async function launch(
  schedules: SchedulerWorkerConfig['schedules'],
  prepareAt?: Date,
  executorId?: string,
  fault?: SchedulerWorkerConfig['fault'],
) {
  const child = spawn(schedules, prepareAt, executorId, fault)
  const ready = await child.wait('ready')
  return { child, port: Number(ready.port) }
}
async function tick(child: SchedulerWorker, at?: Date) {
  child.send('tick', at?.toISOString())
  await child.wait('ticked')
}
const ledger = (scheduleId: string) =>
  db.select().from(jobScheduleRun).where(eq(jobScheduleRun.scheduleId, scheduleId))
const attempts = (scheduleId: string) =>
  db
    .select()
    .from(schedulerAttempts)
    .where(and(eq(schedulerAttempts.runId, runId), eq(schedulerAttempts.scheduleId, scheduleId)))
const effects = (scheduleId: string) =>
  db
    .select()
    .from(schedulerEffects)
    .where(and(eq(schedulerEffects.runId, runId), eq(schedulerEffects.scheduleId, scheduleId)))
async function completed(scheduleId: string) {
  await until(async () => (await ledger(scheduleId)).some((row) => row.state === 'completed'))
}
const slotAfter = (now: Date) => new Date(Math.floor(now.getTime() / 1000) * 1000 + 1000)
async function health(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/health`)
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: (await response.json()) as { jobs: { lastCronAt: string | null } },
  }
}
async function heartbeatWorker() {
  const scheduleId = id()
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const result = await launch(
    [{ id: scheduleId, cron: '0 0 * * *', timeZone: 'UTC', missedRun: 'once', mode: 'heartbeat' }],
    new Date(midnight.getTime() - 1),
  )
  result.child.send('start')
  await result.child.wait('started')
  await completed(scheduleId)
  await until(async () => (await health(result.port)).status === 200)
  return { ...result, scheduleId, midnight }
}

describe('persistent Node scheduler on PostgreSQL', () => {
  it('delivers Singapore 02:00 as the preceding UTC 18:00 Date and rejects invalid startup parameters', async () => {
    const scheduleId = id()
    const scheduledAt = new Date('2030-01-01T18:00:00.000Z')
    const { child } = await launch(
      [{ id: scheduleId, cron: '0 2 * * *', timeZone: 'Asia/Singapore', missedRun: 'once' }],
      new Date('2030-01-01T17:59:59.000Z'),
    )
    const [definition] = await db.select().from(jobSchedule).where(eq(jobSchedule.id, scheduleId))
    expect(definition?.nextScheduledAt).toEqual(scheduledAt)
    await tick(child, scheduledAt)
    expect(await child.wait('handler-started')).toMatchObject({
      scheduledAt: scheduledAt.toISOString(),
      date: true,
    })
    await completed(scheduleId)
    expect((await ledger(scheduleId))[0]?.scheduledAt).toEqual(scheduledAt)
    await child.stop()
    const defaultId = id()
    const { child: defaults } = await launch([{ id: defaultId, cron: '0 2 * * *' }])
    const [defaultDefinition] = await db
      .select()
      .from(jobSchedule)
      .where(eq(jobSchedule.id, defaultId))
    expect(defaultDefinition?.timeZone).toBe('UTC')
    expect(defaultDefinition?.missedRun).toBe('skip')
    await defaults.stop()
    for (const [field, value] of [
      ['cron', 'invalid cron'],
      ['timeZone', 'Invalid/Place'],
    ] as const) {
      const invalid = spawn([{ ...seconds(id()), [field]: value }])
      expect(await invalid.wait('startup-failed')).toMatchObject({
        code: 'SCHEDULER_CONFIG_INVALID',
        parameter: `Invalid scheduler ${field}`,
      })
      await until(async () => invalid.child.exitCode !== null)
      expect(invalid.child.exitCode).toBe(1)
    }
  })

  it('deduplicates a slot across two jobs and never overlaps a long run across subsequent slots', async () => {
    const scheduleId = id()
    const prepareAt = new Date()
    const scheduledAt = slotAfter(prepareAt)
    const definition = { ...seconds(scheduleId), holdMs: 3200 }
    const [first, second] = await Promise.all([
      launch([definition], prepareAt),
      launch([definition], prepareAt),
    ])
    await delay(Math.max(0, scheduledAt.getTime() - Date.now()) + 20)
    await Promise.all([tick(first.child, scheduledAt), tick(second.child, scheduledAt)])
    await until(async () => (await attempts(scheduleId)).length === 1)
    await delay(Math.max(0, scheduledAt.getTime() + 2000 - Date.now()) + 20)
    await Promise.all([tick(first.child), tick(second.child)])
    expect(await ledger(scheduleId)).toHaveLength(1)
    expect(await attempts(scheduleId)).toHaveLength(1)
    await completed(scheduleId)
    expect(await effects(scheduleId)).toHaveLength(1)
    const [attempt] = await attempts(scheduleId)
    expect(attempt?.finishedAt?.getTime()).toBeGreaterThanOrEqual(
      (attempt?.startedAt.getTime() ?? 0) + 2300,
    )
  })

  it('really misses multiple second slots during downtime, skips them or merges only the latest once across two restarts', async () => {
    const skipId = id()
    const onceId = id()
    const definitions = [seconds(skipId), seconds(onceId, 'once')]
    const { child: initial } = await launch(definitions)
    const [before] = await db.select().from(jobSchedule).where(eq(jobSchedule.id, onceId))
    await initial.stop()
    await delay(3300)
    const [first, second] = await Promise.all([launch(definitions), launch(definitions)])
    const restartAt = new Date()
    const latestSlot = new Date(Math.floor(restartAt.getTime() / 1000) * 1000)
    expect(latestSlot.getTime() - (before?.nextScheduledAt.getTime() ?? 0)).toBeGreaterThanOrEqual(
      2000,
    )
    await Promise.all([tick(first.child, restartAt), tick(second.child, restartAt)])
    await completed(onceId)
    expect(await ledger(skipId)).toHaveLength(0)
    expect(await ledger(onceId)).toHaveLength(1)
    expect((await ledger(onceId))[0]?.scheduledAt).toEqual(latestSlot)
    expect(await effects(onceId)).toHaveLength(1)
    const [nextSkip] = await db.select().from(jobSchedule).where(eq(jobSchedule.id, skipId))
    const due = nextSkip?.nextScheduledAt as Date
    await delay(Math.max(0, due.getTime() - Date.now()) + 20)
    await Promise.all([tick(first.child, due), tick(second.child, due)])
    await completed(skipId)
    expect((await ledger(skipId))[0]?.scheduledAt).toEqual(due)
  })

  it('restores a started skip run across two live jobs after SIGKILL with its stable identity and one business effect', async () => {
    const scheduleId = id()
    const prepareAt = new Date()
    const definition = { ...seconds(scheduleId), mode: 'pause-once' as const }
    const { child } = await launch([definition], prepareAt)
    await tick(child, slotAfter(prepareAt))
    await child.wait('before-complete')
    const [original] = await ledger(scheduleId)
    const [firstAttempt] = await attempts(scheduleId)
    await child.stop('SIGKILL')
    const [first, second] = await Promise.all([launch([definition]), launch([definition])])
    await Promise.all([tick(first.child), tick(second.child)])
    await completed(scheduleId)
    expect(await ledger(scheduleId)).toHaveLength(1)
    expect((await ledger(scheduleId))[0]?.id).toBe(original?.id)
    const resumed = await attempts(scheduleId)
    expect(resumed).toHaveLength(2)
    expect(new Set(resumed.map((row) => row.workflowId))).toEqual(
      new Set([firstAttempt?.workflowId]),
    )
    expect(await effects(scheduleId)).toHaveLength(1)
  })

  it('recovers a persisted claimed run killed before publish across two live jobs with one business effect', async () => {
    const scheduleId = id()
    const prepareAt = new Date()
    const scheduledAt = slotAfter(prepareAt)
    const definition = seconds(scheduleId)
    const { child } = await launch([definition], prepareAt, undefined, 'claimed-before-publish')
    child.send('tick', scheduledAt.toISOString())
    await child.wait('before-publish')
    const [original] = await ledger(scheduleId)
    expect(original).toMatchObject({ state: 'claimed', scheduledAt, startedAt: null })
    expect(await attempts(scheduleId)).toHaveLength(0)
    await child.stop('SIGKILL')
    const [first, second] = await Promise.all([launch([definition]), launch([definition])])
    await Promise.all([tick(first.child), tick(second.child)])
    await completed(scheduleId)
    expect(await ledger(scheduleId)).toHaveLength(1)
    expect((await ledger(scheduleId))[0]?.id).toBe(original?.id)
    const resumed = await attempts(scheduleId)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.workflowId).toBe(`schedule-run:${original?.id}`)
    expect(await effects(scheduleId)).toHaveLength(1)
  })

  it('recovers native ERROR after a successful handler checkpoint without repeating its callback', async () => {
    const scheduleId = id()
    const prepareAt = new Date()
    const { child } = await launch(
      [seconds(scheduleId)],
      prepareAt,
      undefined,
      'finish-after-checkpoint',
    )
    await tick(child, slotAfter(prepareAt))
    const fault = await child.wait('finish-failed')
    const [original] = await ledger(scheduleId)
    const workflowId = `schedule-run:${original?.id}`
    expect(fault.workflowId).toBe(workflowId)
    await until(async () => {
      child.send('workflow-status', workflowId)
      return (await child.wait('workflow-status')).status === 'ERROR'
    })
    expect(original?.state).toBe('running')
    expect(await attempts(scheduleId)).toHaveLength(1)
    await tick(child)
    await completed(scheduleId)
    expect(await ledger(scheduleId)).toHaveLength(1)
    expect((await ledger(scheduleId))[0]?.id).toBe(original?.id)
    expect(await attempts(scheduleId)).toHaveLength(1)
    expect((await attempts(scheduleId))[0]?.workflowId).toBe(workflowId)
    expect(await effects(scheduleId)).toHaveLength(1)
  })

  it('loses an owner connection without taking over the still live worker or accepting its late completion', async () => {
    const scheduleId = id()
    const executorId = `owner-${randomUUID()}`
    const prepareAt = new Date()
    const definition = { ...seconds(scheduleId), mode: 'gated' as const }
    const { child } = await launch([definition], prepareAt, executorId)
    await tick(child, slotAfter(prepareAt))
    await child.wait('before-complete')
    const [original] = await ledger(scheduleId)
    const key = createHash('sha256').update(`product-res-job-engine:${executorId}`).digest('hex')
    const terminated = await db.execute<{
      terminated: boolean
    }>(sql`SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_locks WHERE locktype='advisory' AND granted
        AND classid=${Number.parseInt(key.slice(0, 8), 16)}::oid AND objid=${Number.parseInt(key.slice(8, 16), 16)}::oid`)
    expect(terminated).toHaveLength(1)
    expect(terminated[0]?.terminated).toBe(true)
    await until(async () => child.output().includes('platform.job_engine.ownership_lost'))
    child.send('release')
    await child.wait('handler-returned')
    const { child: competitor } = await launch([definition])
    await tick(competitor)
    await delay(500)
    expect(await attempts(scheduleId)).toHaveLength(1)
    expect((await ledger(scheduleId))[0]).toMatchObject({
      id: original?.id,
      state: 'running',
      finishedAt: null,
      executorId,
    })
    child.send('health')
    expect(await child.wait('health')).toMatchObject({ status: 'down' })
    expect(child.child.exitCode).toBeNull()
    await child.stop('SIGKILL')
    await tick(competitor)
    await competitor.wait('before-complete')
    competitor.send('release')
    await competitor.wait('handler-returned')
    // 失权后的 callback 未缓存成功结果；新 owner 重做并复用同一幂等业务结果。
    await completed(scheduleId)
    expect((await ledger(scheduleId))[0]?.id).toBe(original?.id)
    expect(await effects(scheduleId)).toHaveLength(1)
  })

  it('stops receiving on SIGTERM while preserving an unfinished run for restart', async () => {
    const scheduleId = id()
    const prepareAt = new Date()
    const definition = { ...seconds(scheduleId), mode: 'pause-once' as const }
    const { child } = await launch([definition], prepareAt)
    await tick(child, slotAfter(prepareAt))
    await child.wait('before-complete')
    const [original] = await ledger(scheduleId)
    const exited = child.stop('SIGTERM')
    await child.wait('stopping')
    await tick(child, new Date(Date.now() + 10000))
    expect(await ledger(scheduleId)).toHaveLength(1)
    await exited
    expect(child.child.exitCode).toBe(0)
    const { child: recovered } = await launch([definition])
    await tick(recovered)
    await completed(scheduleId)
    expect((await ledger(scheduleId))[0]?.id).toBe(original?.id)
    expect(await effects(scheduleId)).toHaveLength(1)
  })

  it('serves uncached HTTP health from actual successful heartbeat and preserves it after a failed precondition', async () => {
    await db.delete(setting).where(eq(setting.key, 'jobs.lastCronAt'))
    const scheduleId = id()
    const { child, port } = await launch([seconds(scheduleId, 'once')])
    child.send('start')
    await child.wait('started')
    expect(await health(port)).toMatchObject({
      status: 503,
      cache: 'no-store',
      body: { jobs: { lastCronAt: null } },
    })
    await child.stop()
    const heartbeat = await heartbeatWorker()
    const success = await health(heartbeat.port)
    const lastCronAt = success.body.jobs.lastCronAt as string
    expect(lastCronAt).toBe(new Date(lastCronAt).toISOString())
    heartbeat.child.send('fail-next')
    await heartbeat.child.wait('will-fail')
    await tick(heartbeat.child, new Date(heartbeat.midnight.getTime() + 86400000))
    await until(async () =>
      (await ledger(heartbeat.scheduleId)).some((row) => row.state === 'failed'),
    )
    expect((await health(heartbeat.port)).body.jobs.lastCronAt).toBe(lastCronAt)
    const old = new Date(Date.now() - 601000)
    await recordLastCronAt(db, old)
    expect(await health(heartbeat.port)).toMatchObject({
      status: 503,
      cache: 'no-store',
      body: { jobs: { lastCronAt: old.toISOString() } },
    })
    expect(heartbeat.child.output()).not.toContain('PRIVATE_SCHEDULER_PAYLOAD')
  })

  it.skipIf(process.env.TEST_SCHEDULER_LONG !== '1')(
    'keeps a real heartbeat stale after stopping jobs for more than ten minutes',
    async () => {
      const { child, port } = await heartbeatWorker()
      const before = await health(port)
      expect(before.status).toBe(200)
      child.send('pause')
      await child.wait('paused')
      // 真实经过两个五分钟周期；不修改时间或持久心跳，单独开启避免快速回归反复长跑。
      await delay(601000)
      expect(await health(port)).toMatchObject({
        status: 503,
        cache: 'no-store',
        body: { jobs: { lastCronAt: before.body.jobs.lastCronAt } },
      })
    },
    650000,
  )
})
