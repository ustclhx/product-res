import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createDb } from '@product-res/db'
import { sql } from 'drizzle-orm'
import { createNodeJobEngine } from '../../../src/node/job-engine.ts'
import { cleanupNodeQueues } from '../../../src/node/job-maintenance.ts'
import { createNodeQueueAdapter } from '../../../src/node/job-queue.ts'
import type { Body, WorkerConfig } from '../job-queue.helpers.ts'

const config = JSON.parse(process.env.TEST_JOB_WORKER_CONFIG ?? '{}') as WorkerConfig
const url = process.env.TEST_JOB_DATABASE_URL
if (!url) throw new Error('TEST_JOB_DATABASE_URL is required')
const db = createDb(url, { max: 3 })
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  process.send?.({ event, ...fields })
const pause = () => new Promise<never>(() => {})
const foreignWorkflow = DBOS.registerWorkflow(
  async () => {
    await DBOS.sleepms(86_400_000)
  },
  { name: 'test-foreign-early-event' },
)
let adapter: ReturnType<typeof createNodeQueueAdapter>

// 在公开 SDK 接受边界暂停，父进程会 SIGKILL；不改第三方持久表。
if (config.fault === 'accepted') {
  const original = DBOS.startWorkflow.bind(DBOS)
  DBOS.startWorkflow = ((...args: Parameters<typeof original>) => {
    const invoke = original(...args)
    return async (...params: unknown[]) => {
      const handle = await (invoke as (...values: unknown[]) => Promise<unknown>)(...params)
      emit('accepted')
      await pause()
      return handle
    }
  }) as typeof DBOS.startWorkflow
}

const engine = await createNodeJobEngine({
  database: db,
  databaseUrl: url,
  executorId: config.executorId,
  applicationVersion: 'job-engine-integration-v1',
  ownershipDirectory: config.ownershipDirectory,
  nativePoolMax: 3,
  register(engine) {
    adapter = createNodeQueueAdapter({
      db,
      executorId: config.executorId,
      ownershipToken: engine.ownershipToken,
      assertOwnership: () => engine.assertOwnership(),
      isExecutorStopped: (id, token) => engine.isExecutorStopped(id, token),
      pollIntervalMs: 100,
    })
    for (const queue of config.queues) {
      adapter.register<Body>(
        queue.name,
        async (batch, deadLetterSink) => {
          emit('batch-started')
          const batchId = DBOS.workflowID ?? randomUUID()
          await Promise.all(
            batch.messages.map(async (message) => {
              const { body } = message
              await db.execute(sql`INSERT INTO test_job_engine_attempt
            (run_id,message_id,key,queue,executor_id,batch_id,batch_size,attempt)
            VALUES (${config.runId},${message.id},${body.key},${batch.queue},
              ${config.executorId},${batchId},${batch.messages.length},${message.attempts})`)
              if (body.holdMs) await delay(body.holdMs)
              if (body.mode === 'retry' || (body.mode === 'retry-once' && message.attempts === 1)) {
                message.retry()
              } else if (body.mode === 'permanent') {
                await deadLetterSink.failed(message, {
                  code: 'TEST_PERMANENT_FAILURE',
                  retryable: false,
                })
                // failed 必须已持久存储；确认由合同明确表达。
                emit('dead-letter-recorded')
                message.ack()
              } else if (body.mode === 'invalid') {
                message.ack()
              } else {
                const inserted =
                  await db.execute(sql`INSERT INTO test_job_engine_effect (run_id,key)
              VALUES (${config.runId},${body.key}) ON CONFLICT DO NOTHING RETURNING key`)
                if (body.mode === 'before-ack' && inserted.length > 0) {
                  emit('before-ack')
                  await pause()
                }
                message.ack()
              }
              await db.execute(sql`UPDATE test_job_engine_attempt SET finished_at=clock_timestamp()
            WHERE run_id=${config.runId} AND message_id=${message.id}
              AND attempt=${message.attempts} AND executor_id=${config.executorId}
              AND finished_at IS NULL`)
            }),
          )
        },
        queue.policy,
      )
    }
  },
  async start() {
    await adapter.prepare()
  },
  stopReceiving() {
    adapter.stopReceiving()
  },
  shutdownTimeoutMs: 5_000,
})

process.on('message', (message: { command?: string; queue?: string }) => {
  void (async () => {
    if (message.command === 'cleanup' && message.queue) {
      const input = message.queue.startsWith('{')
        ? JSON.parse(message.queue)
        : { now: message.queue }
      const summary = await cleanupNodeQueues(db, { ...input, now: new Date(input.now) })
      emit('cleaned', { ...summary })
    }
    if (message.command === 'foreign' && message.queue) {
      await DBOS.startWorkflow(foreignWorkflow, { workflowID: message.queue })()
      await DBOS.send(message.queue, { privateContent: 'SECRET_EARLY_EVENT' }, 'early')
      emit('foreign-started')
    }
    if (message.command === 'close') {
      await engine.close()
      emit('engine-closed')
    }
    if (message.command === 'cancel' && message.queue) {
      await DBOS.cancelWorkflow(message.queue)
      emit('cancelled')
    }
    if (message.command === 'start') adapter.start()
    if (message.command === 'pause') {
      adapter.stopReceiving()
      emit('paused')
    }
    if (message.command === 'claim' && message.queue) {
      const id = await adapter.claim(message.queue)
      if (!id) throw new Error('No batch claimed at fault boundary')
      emit('claimed')
    }
  })().catch((error: unknown) => {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN'
    emit('command-failed', { code })
    process.exitCode = 1
  })
})
process.once('SIGTERM', () => {
  void engine
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
})
emit('ready', { executorId: engine.executorId, token: engine.ownershipToken })
