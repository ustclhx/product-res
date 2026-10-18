import { DBOS } from '@dbos-inc/dbos-sdk'
import { jobSchedule, jobScheduleRun } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import { log, withLogContext } from '@product-res/shared/log'
import { CronExpressionParser } from 'cron-parser'
import { and, eq, inArray } from 'drizzle-orm'
import type { SchedulerHealth } from '../capabilities.ts'
import type { DatabaseTransaction } from '../queue.ts'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '../scheduler.ts'
import type { NodeJobEngine } from './job-engine.ts'
import { readNodeCronHeartbeat } from './task-health.ts'

export interface NodeSchedulerOptions {
  readonly engine: NodeJobEngine
  readonly pollIntervalMs?: number
}
export type NodeScheduleDefinition = Omit<ScheduleDefinition, 'timeZone' | 'missedRun'> &
  Partial<Pick<ScheduleDefinition, 'timeZone' | 'missedRun'>>

type Registration = { definition: ScheduleDefinition; handler: ScheduledHandler }
type Run = typeof jobScheduleRun.$inferSelect
const active = ['claimed', 'running']
const workflowId = (id: string) => `schedule-run:${id}`
const invalid = (field: string) =>
  new AppError('SCHEDULER_CONFIG_INVALID', `Invalid scheduler ${field}`)
const ownershipLost = () =>
  new AppError('SCHEDULER_OWNERSHIP_LOST', 'Schedule execution ownership lost', { status: 503 })

/** UTC 是既有任务默认值；例如新加坡每日 02:00 显式注册 Asia/Singapore。 */
export function createNodeScheduler(options: NodeSchedulerOptions) {
  const { engine } = options
  const db = engine.database
  const registrations = new Map<string, Registration>()
  const executing = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  let prepared = false
  let receiving = false
  let stopped = false
  let lastPollSucceeded = false
  let polling: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw invalid('pollIntervalMs')

  function expression(definition: ScheduleDefinition, currentDate: Date) {
    return CronExpressionParser.parse(definition.cron, { tz: definition.timeZone, currentDate })
  }
  function next(definition: ScheduleDefinition, date: Date) {
    return expression(definition, date).next().toDate()
  }
  function latest(definition: ScheduleDefinition, date: Date) {
    // prev 是严格早于；加一毫秒使恰好到达的 slot 也可领取。
    return expression(definition, new Date(date.getTime() + 1))
      .prev()
      .toDate()
  }
  function register(input: NodeScheduleDefinition, handler: ScheduledHandler): void {
    if (prepared) throw invalid('registration phase')
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))
      throw invalid('id')
    if (registrations.has(input.id)) throw invalid('duplicate id')
    const definition: ScheduleDefinition = {
      ...input,
      timeZone: input.timeZone ?? 'UTC',
      missedRun: input.missedRun ?? 'skip',
    }
    if (!['skip', 'once'].includes(definition.missedRun)) throw invalid('missedRun')
    try {
      new Intl.DateTimeFormat('en', { timeZone: definition.timeZone }).format()
    } catch {
      throw invalid('timeZone')
    }
    try {
      if (typeof definition.cron !== 'string') throw invalid('cron')
      next(definition, new Date())
    } catch {
      throw invalid('cron')
    }
    if (typeof handler !== 'function') throw invalid('handler')
    registrations.set(definition.id, { definition, handler })
  }
  async function lockSchedule(tx: DatabaseTransaction, id: string) {
    const [schedule] = await tx
      .select()
      .from(jobSchedule)
      .where(eq(jobSchedule.id, id))
      .for('update')
    if (!schedule) throw invalid('unprepared schedule')
    return schedule
  }
  async function prepare(now = new Date()) {
    await engine.assertOwnership()
    for (const { definition } of registrations.values()) {
      await db.transaction(async (tx) => {
        await tx
          .insert(jobSchedule)
          .values({ ...definition, nextScheduledAt: next(definition, now) })
          .onConflictDoNothing()
        const schedule = await lockSchedule(tx, definition.id)
        if (
          schedule.cron !== definition.cron ||
          schedule.timeZone !== definition.timeZone ||
          schedule.missedRun !== definition.missedRun
        )
          throw invalid(`persisted definition (${definition.id})`)
        // 新 incarnation 的 skip 只丢弃未领取 slot，已有活动 run 单独恢复。
        if (definition.missedRun === 'skip' && schedule.nextScheduledAt <= now)
          await tx
            .update(jobSchedule)
            .set({ nextScheduledAt: next(definition, now) })
            .where(eq(jobSchedule.id, definition.id))
      })
    }
    prepared = true
  }
  async function claim(scheduleId: string, now = new Date()): Promise<string | null> {
    await engine.assertOwnership()
    if (!prepared || !registrations.has(scheduleId)) throw invalid('unprepared schedule')
    if (stopped) return null
    const { definition } = registrations.get(scheduleId) as Registration
    return db.transaction(async (tx) => {
      const schedule = await lockSchedule(tx, scheduleId)
      const [run] = await tx
        .select()
        .from(jobScheduleRun)
        .where(
          and(eq(jobScheduleRun.scheduleId, scheduleId), inArray(jobScheduleRun.state, active)),
        )
      if (stopped) return null
      if (run) {
        // 长运行的 skip 立即推进持久游标；once 留待运行结束后合并最近一次。
        if (definition.missedRun === 'skip' && schedule.nextScheduledAt <= now)
          await tx
            .update(jobSchedule)
            .set({ nextScheduledAt: next(definition, now) })
            .where(eq(jobSchedule.id, scheduleId))
        return run.id
      }
      if (schedule.nextScheduledAt > now) return null
      const scheduledAt = latest(definition, now)
      if (definition.missedRun === 'skip' && schedule.nextScheduledAt < scheduledAt) {
        await tx
          .update(jobSchedule)
          .set({ nextScheduledAt: next(definition, now) })
          .where(eq(jobSchedule.id, scheduleId))
        await engine.assertOwnership()
        return null
      }
      const id = newId()
      await tx.insert(jobScheduleRun).values({ id, scheduleId, scheduledAt })
      await tx
        .update(jobSchedule)
        .set({ nextScheduledAt: next(definition, now) })
        .where(eq(jobSchedule.id, scheduleId))
      await engine.assertOwnership()
      return id
    })
  }
  async function own(id: string, running: boolean): Promise<Run | undefined> {
    await engine.assertOwnership()
    const [peek] = await db.select().from(jobScheduleRun).where(eq(jobScheduleRun.id, id))
    if (!peek || !active.includes(peek.state)) return undefined
    return db.transaction(async (tx) => {
      await lockSchedule(tx, peek.scheduleId)
      const [run] = await tx
        .select()
        .from(jobScheduleRun)
        .where(eq(jobScheduleRun.id, id))
        .for('update')
      if (!run || !active.includes(run.state)) return undefined
      if (
        run.executorId &&
        (run.executorId !== engine.executorId || run.executorToken !== engine.ownershipToken) &&
        (!running || run.state === 'running') &&
        !(await engine.isExecutorStopped(run.executorId, run.executorToken ?? undefined))
      )
        return undefined
      if (stopped || (running && executing.has(id))) return undefined
      const [owned] = await tx
        .update(jobScheduleRun)
        .set({
          executorId: engine.executorId,
          executorToken: engine.ownershipToken,
          ...(running ? { state: 'running', startedAt: run.startedAt ?? new Date() } : {}),
          // 发布权不等于执行权；恢复进入共享 native 队列后，由实际领取者接管 claimed。
          ...(!running ? { state: 'claimed' } : {}),
        })
        .where(eq(jobScheduleRun.id, id))
        .returning()
      await engine.assertOwnership()
      return owned
    })
  }
  async function finish(id: string, state: 'completed' | 'failed') {
    await engine.assertOwnership()
    await db.transaction(async (tx) => {
      const [peek] = await tx.select().from(jobScheduleRun).where(eq(jobScheduleRun.id, id))
      if (!peek) throw ownershipLost()
      await lockSchedule(tx, peek.scheduleId)
      const [run] = await tx
        .select()
        .from(jobScheduleRun)
        .where(eq(jobScheduleRun.id, id))
        .for('update')
      if (
        run?.executorId !== engine.executorId ||
        run.executorToken !== engine.ownershipToken ||
        run.state !== 'running'
      )
        throw ownershipLost()
      await engine.assertOwnership()
      const finishedAt = new Date()
      await tx
        .update(jobScheduleRun)
        .set({
          state,
          finishedAt,
          errorCode: state === 'failed' ? 'SCHEDULE_HANDLER_FAILED' : null,
        })
        .where(eq(jobScheduleRun.id, id))
      const { definition } = registrations.get(run.scheduleId) as Registration
      // 完成瞬间仍跨 slot 时，skip 不得在下一轮把该 slot 当成正常运行。
      if (definition.missedRun === 'skip')
        await tx
          .update(jobSchedule)
          .set({ nextScheduledAt: next(definition, finishedAt) })
          .where(eq(jobSchedule.id, run.scheduleId))
      // 锁等待中可能失权；提交前复验让旧 incarnation 的完成写入随事务回滚。
      await engine.assertOwnership()
    })
  }
  const native = DBOS.registerWorkflow(
    async (id: string) => {
      if (!prepared || stopped) throw ownershipLost()
      const run = await own(id, true)
      if (!run || stopped) throw ownershipLost()
      const registration = registrations.get(run.scheduleId)
      if (!registration) throw invalid('missing handler')
      executing.add(id)
      try {
        let failed = false
        await DBOS.runStep(
          async () => {
            if (stopped) throw ownershipLost()
            await engine.assertOwnership()
            try {
              await withLogContext({ jobId: id, scheduleId: run.scheduleId }, () =>
                registration.handler({ scheduledAt: run.scheduledAt }),
              )
            } catch {
              failed = true
            }
            await engine.assertOwnership()
            return failed
          },
          { name: 'schedule.handler:v1', retriesAllowed: false },
        ).then((result) => {
          failed = result
        })
        await finish(id, failed ? 'failed' : 'completed')
        if (failed)
          log.error('platform.scheduler.handler_failed', { jobId: id, scheduleId: run.scheduleId })
      } finally {
        executing.delete(id)
      }
    },
    { name: 'product-res-schedule-run:v1', serialization: 'portable' },
  )

  async function publish(id: string) {
    if (stopped || inFlight.has(id) || executing.has(id)) return
    const run = await own(id, false)
    if (!run || stopped || executing.has(id)) return
    const status = await DBOS.getWorkflowStatus(workflowId(id))
    // 稳定 ID 复用原成功 step；仅在退出证明通过之后恢复 native 状态，不能用 TTL 接管。
    // 5.2.11 resume 不处理 ERROR/SUCCESS；公开 rewind 保留成功 handler 的 checkpoint，
    // 只重做尚未成功的步骤和 ledger 完成。绝不手写第三方 journal。
    const terminal = status && !['PENDING', 'ENQUEUED', 'DELAYED'].includes(status.status)
    const steps = terminal ? await DBOS.listWorkflowSteps(workflowId(id)) : undefined
    const handler = steps?.find((step) => step.name === 'schedule.handler:v1' && !step.error)
    const handle = !status
      ? await DBOS.startWorkflow(native, { workflowID: workflowId(id) })(id)
      : terminal
        ? await DBOS.rewindWorkflow<void>(workflowId(id), {
            startStep: handler ? handler.functionID + 1 : 0,
          })
        : status.status === 'PENDING' && status.executorId === engine.executorId
          ? DBOS.retrieveWorkflow<void>(workflowId(id))
          : await DBOS.resumeWorkflow<void>(workflowId(id))
    const work = handle.getResult().then(
      () => {},
      () => {},
    )
    inFlight.set(id, work)
    void work.finally(() => inFlight.delete(id))
  }
  async function tick(now = new Date()) {
    try {
      await engine.assertOwnership()
      if (!prepared) throw invalid('preparation phase')
      for (const id of registrations.keys()) {
        if (stopped) break
        const runId = await claim(id, now)
        if (runId) await publish(runId)
      }
      lastPollSucceeded = true
    } catch (error) {
      lastPollSucceeded = false
      throw error
    }
  }
  function stopReceiving() {
    stopped = true
    receiving = false
    lastPollSucceeded = false
    clearTimeout(timer)
  }
  function loop() {
    if (!receiving) return
    polling = tick()
      .catch(() => {
        log.error('platform.scheduler.poll_failed', { executorId: engine.executorId })
      })
      .finally(() => {
        if (receiving) timer = setTimeout(loop, pollIntervalMs)
      })
  }
  const scheduler = {
    register,
    prepare,
    claim,
    publish,
    tick,
    stopReceiving,
    start() {
      if (!prepared) throw invalid('preparation phase')
      if (receiving) return
      stopped = false
      receiving = true
      lastPollSucceeded = false
      loop()
    },
    async health(): Promise<SchedulerHealth> {
      let lastCronAt: string | null = null
      try {
        lastCronAt = await readNodeCronHeartbeat(db)
        await engine.assertOwnership()
        if (!DBOS.isInitialized()) return { status: 'down', lastCronAt }
        await db.select({ id: jobSchedule.id }).from(jobSchedule).limit(1)
        return {
          status: registrations.size > 0 && receiving && lastPollSucceeded ? 'up' : 'down',
          lastCronAt,
        }
      } catch {
        return { status: 'down', lastCronAt }
      }
    },
    async drain(timeoutMs: number) {
      stopReceiving()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          // publisher 可能在 stop 前已被 native 接受；先等本轮收尾，再快照在途运行。
          Promise.resolve(polling)
            .then(() => Promise.all([...inFlight.values()]))
            .then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    },
  }
  return scheduler satisfies Scheduler
}
