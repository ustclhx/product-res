import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createDb } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import { createNodeJobEngine } from '../../../src/node/job-engine.ts'
import { createNodeQueueAdapter } from '../../../src/node/job-queue.ts'
import { createNodeScheduler } from '../../../src/node/scheduler.ts'
import {
  createNodeCronHeartbeat,
  createNodeTaskHealth,
  createNodeTaskHealthResponse,
} from '../../../src/node/task-health.ts'
import type { ScheduledHandler } from '../../../src/scheduler.ts'
import type { SchedulerWorkerConfig } from '../scheduler.helpers.ts'

const config = JSON.parse(process.env.TEST_SCHEDULER_WORKER_CONFIG ?? '{}') as SchedulerWorkerConfig
const url = process.env.TEST_JOB_DATABASE_URL
if (!url) throw new Error('TEST_JOB_DATABASE_URL is required')
const db = createDb(url, { max: 3 })
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  process.send?.({ event, ...fields })
let scheduler!: ReturnType<typeof createNodeScheduler>
let queue!: ReturnType<typeof createNodeQueueAdapter>
let release: (() => void) | undefined
let failNext = false
let finishFaultPending = false
let faultInjected = false

// 故障只在隔离 fixture 注入，保留 SDK 的成功 checkpoint 与生产数据库事务行为。
const runStep = DBOS.runStep.bind(DBOS)
DBOS.runStep = (async (...args: Parameters<typeof DBOS.runStep>) => {
  const result = await runStep(...args)
  if (
    config.fault === 'finish-after-checkpoint' &&
    args[1]?.name === 'schedule.handler:v1' &&
    !faultInjected
  )
    finishFaultPending = true
  return result
}) as typeof DBOS.runStep
const transaction = db.transaction.bind(db)
db.transaction = (async (...args: Parameters<typeof db.transaction>) => {
  if (DBOS.workflowID && finishFaultPending) {
    finishFaultPending = false
    faultInjected = true
    emit('finish-failed', { workflowId: DBOS.workflowID })
    throw new AppError('TEST_SCHEDULE_FINISH_TRANSIENT', 'Injected transient ledger failure')
  }
  const result = await transaction(...args)
  if (
    config.fault === 'claimed-before-publish' &&
    !faultInjected &&
    result &&
    typeof result === 'object' &&
    'state' in result &&
    result.state === 'claimed' &&
    'executorId' in result &&
    result.executorId === config.executorId
  ) {
    faultInjected = true
    emit('before-publish')
    await new Promise<void>(() => {})
  }
  return result
}) as typeof db.transaction

try {
  const engine = await createNodeJobEngine({
    database: db,
    databaseUrl: url,
    executorId: config.executorId,
    ownershipDirectory: config.ownershipDirectory,
    applicationVersion: 'scheduler-integration-v1',
    nativePoolMax: 3,
    shutdownTimeoutMs: 600,
    async register(engine) {
      scheduler = createNodeScheduler({ engine, pollIntervalMs: 50 })
      queue = createNodeQueueAdapter({
        db,
        executorId: engine.executorId,
        ownershipToken: engine.ownershipToken,
        assertOwnership: () => engine.assertOwnership(),
        isExecutorStopped: (id, token) => engine.isExecutorStopped(id, token),
        pollIntervalMs: 50,
      })
      queue.register(`scheduler-test-${config.executorId}`, async (batch) => {
        batch.ackAll()
      })
      for (const definition of config.schedules) {
        const handler: ScheduledHandler = async ({ scheduledAt }) => {
          if (failNext) {
            failNext = false
            throw new AppError('TEST_PRECONDITION_FAILED', 'PRIVATE_SCHEDULER_PAYLOAD')
          }
          emit('handler-entered', { scheduleId: definition.id, date: scheduledAt instanceof Date })
          const workflowId = DBOS.workflowID
          if (!workflowId) throw new Error('Missing durable schedule identity')
          await db.execute(sql`INSERT INTO test_scheduler_attempt
            (run_id,schedule_id,scheduled_at,workflow_id,executor_id)
            VALUES (${config.runId},${definition.id},${scheduledAt.toISOString()},${workflowId},${config.executorId})`)
          emit('handler-started', {
            scheduleId: definition.id,
            scheduledAt: scheduledAt.toISOString(),
            date: scheduledAt instanceof Date,
          })
          if (definition.holdMs) await delay(definition.holdMs)
          const inserted = await db.execute(sql`INSERT INTO test_scheduler_effect
            (run_id,schedule_id,scheduled_at) VALUES (${config.runId},${definition.id},${scheduledAt.toISOString()})
            ON CONFLICT DO NOTHING RETURNING schedule_id`)
          if (definition.mode === 'pause-once' && inserted.length > 0) {
            emit('before-complete')
            await new Promise<void>(() => {})
          }
          if (definition.mode === 'gated') {
            emit('before-complete')
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          await db.execute(sql`UPDATE test_scheduler_attempt SET finished_at=clock_timestamp()
            WHERE run_id=${config.runId} AND schedule_id=${definition.id} AND scheduled_at=${scheduledAt.toISOString()}
              AND executor_id=${config.executorId} AND finished_at IS NULL`)
          emit('handler-returned')
        }
        scheduler.register(
          definition,
          definition.mode === 'heartbeat' ? createNodeCronHeartbeat(db, handler) : handler,
        )
      }
      await scheduler.prepare(config.prepareAt ? new Date(config.prepareAt) : undefined)
    },
    async start() {
      await queue.prepare()
      queue.start()
    },
    stopReceiving() {
      scheduler?.stopReceiving()
      queue?.stopReceiving()
    },
  })
  const response = createNodeTaskHealthResponse(createNodeTaskHealth({ queue, scheduler }))
  const server = createServer((_request, reply) => {
    void response().then(async (result) => {
      reply.writeHead(result.status, Object.fromEntries(result.headers))
      reply.end(await result.text())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  process.on('message', (message: { command?: string; now?: string }) => {
    void (async () => {
      if (message.command === 'tick') {
        await scheduler.tick(message.now ? new Date(message.now) : undefined)
        emit('ticked')
      }
      if (message.command === 'start') {
        scheduler.start()
        emit('started')
      }
      if (message.command === 'pause') {
        scheduler.stopReceiving()
        emit('paused')
      }
      if (message.command === 'release') {
        release?.()
        emit('released')
      }
      if (message.command === 'health') emit('health', { ...(await scheduler.health()) })
      if (message.command === 'workflow-status' && message.now)
        emit('workflow-status', { ...(await DBOS.getWorkflowStatus(message.now)) })
      if (message.command === 'fail-next') {
        failNext = true
        emit('will-fail')
      }
    })().catch((error: unknown) => {
      emit('command-failed', { code: error instanceof AppError ? error.code : 'UNKNOWN' })
    })
  })
  process.once('SIGTERM', () => {
    engine.stopReceiving()
    emit('stopping')
    void engine
      .close()
      .then(() => db.close())
      .then(() => server.close(() => process.exit(0)))
  })
  emit('ready', { port: address.port })
} catch (error) {
  emit('startup-failed', {
    code: error instanceof AppError ? error.code : 'UNKNOWN',
    parameter:
      error instanceof AppError && error.code === 'SCHEDULER_CONFIG_INVALID'
        ? error.message
        : undefined,
  })
  await db.close()
  process.exit(1)
}
