import { setTimeout as delay } from 'node:timers/promises'
import { createDb, type Database } from '@product-res/db'
import { sql } from 'drizzle-orm'
import { createNodeJobEngine } from '../../../src/node/job-engine.ts'
import { createNodeWorkflow } from '../../../src/node/workflow.ts'
import { cleanupNodeWorkflowEvents } from '../../../src/node/workflow-events.ts'
import {
  type JsonValue,
  NonRetryableError,
  type Workflow,
  type WorkflowStep,
} from '../../../src/workflow.ts'
import type { WorkflowWorkerConfig } from '../workflow.helpers.ts'

const config: WorkflowWorkerConfig = JSON.parse(process.env.TEST_WORKFLOW_WORKER_CONFIG ?? '{}')
const url = process.env.TEST_JOB_DATABASE_URL
if (!url) throw new Error('TEST_JOB_DATABASE_URL required')
const db = createDb(url, { max: 3 })
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  process.send?.({ event, ...fields })
type Params = {
  key: string
  mode: string
  sleepMs?: number
  secondSleepMs?: number
  timeoutMs?: number
  failures?: number
  limit?: number
  delayMs?: number
  backoff?: 'constant' | 'linear' | 'exponential'
  invalid?: string
}
let workflow: Workflow<Params> & { stopReceiving(): void }
let journalCrashKey: string | undefined
// 只在测试 facade 注入“自有消费已提交、native checkpoint 未写”的精确退出窗口。
const engineDatabase = new Proxy(db, {
  get(target, property, receiver) {
    if (property !== 'transaction') return Reflect.get(target, property, receiver)
    return async (...args: Parameters<Database['transaction']>) => {
      const result = await target.transaction(...args)
      if (
        journalCrashKey &&
        result &&
        typeof result === 'object' &&
        'state' in result &&
        result.state === 'completed'
      ) {
        const key = journalCrashKey
        if ((await effect(key, 'journal-crash')).length > 0) {
          emit('event-consumed-before-checkpoint', { key })
          await new Promise<never>(() => {})
        }
      }
      return result
    }
  },
})

async function count(key: string, step: string) {
  await db.execute(
    sql`INSERT INTO test_workflow_attempt (run_id,key,step) VALUES (${config.runId},${key},${step})`,
  )
  const rows = await db.execute<{
    count: number
  }>(sql`SELECT count(*)::int AS count FROM test_workflow_attempt
    WHERE run_id=${config.runId} AND key=${key} AND step=${step}`)
  return rows[0]?.count ?? 0
}
async function effect(key: string, step: string) {
  return db.execute(sql`INSERT INTO test_workflow_effect(run_id,key,step)
    VALUES (${config.runId},${key},${step}) ON CONFLICT DO NOTHING RETURNING step`)
}
function invalid(kind: string): JsonValue {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const values: Record<string, unknown> = {
    date: new Date(),
    nan: Number.NaN,
    bigint: 1n,
    undefined: { nested: undefined },
    binary: new Uint8Array([1]),
    circular,
    function: { nested: () => 1 },
  }
  return values[kind] as JsonValue
}
async function handler(params: Params, step: WorkflowStep): Promise<JsonValue> {
  const { key, mode } = params
  if (mode === 'event-checkpoint') {
    journalCrashKey = key
    const event = await step.waitForEvent('atomic-event', { type: 'early', timeoutMs: 30_000 })
    return { payload: event.payload as JsonValue, timestamp: event.timestamp.toISOString() }
  }
  if (mode === 'failure') throw new Error('SECRET_WORKFLOW_FAILURE')
  if (mode === 'invalid-output') return invalid(params.invalid ?? 'date')
  if (mode === 'invalid-step')
    return step.do('invalid', async () => invalid(params.invalid ?? 'date'))
  if (mode === 'retry') {
    const result = await step.do(
      'retry',
      {
        retries: {
          limit: params.limit ?? 3,
          delayMs: params.delayMs ?? 100,
          backoff: params.backoff ?? 'linear',
        },
        timeoutMs: params.timeoutMs ?? 120_000,
      },
      async () => {
        if ((await count(key, 'retry')) <= (params.failures ?? 3))
          throw new Error('SECRET_RETRY_FAILURE')
        await effect(key, 'retry')
        return { succeeded: true }
      },
    )
    return result
  }
  if (mode === 'nonretryable') {
    try {
      await step.do(
        'submit',
        { retries: { limit: 3, delayMs: 100, backoff: 'linear' } },
        async () => {
          await count(key, 'submit')
          throw Object.assign(new NonRetryableError('SECRET_SUBMISSION_UNCERTAIN'), {
            code: 'FIXTURE_PROVIDER_REJECTED',
          })
        },
      )
    } catch (error) {
      await step.do('settlement', async () => {
        await count(key, 'settlement')
        await effect(key, 'release-hold')
        return null
      })
      // 与 CF adapter 同一契约：跨 step 还原共享错误类型与业务 code。
      const carriedCode =
        error instanceof NonRetryableError && 'code' in error ? (error.code as string) : null
      return { businessStatus: 'failed', holdReleased: true, carriedCode }
    }
    return { businessStatus: 'failed', holdReleased: true, carriedCode: null }
  }
  if (mode === 'timeout') {
    try {
      await step.do('slow', { timeoutMs: 50 }, async () => {
        await count(key, 'slow')
        await delay(300)
        await effect(key, 'uncooperative-callback')
        return null
      })
      return { timedOut: false }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'WORKFLOW_STEP_TIMEOUT'))
        throw error
      return { timedOut: true }
    }
  }
  if (mode === 'crash-window') {
    return step.do('effect', async () => {
      await count(key, 'effect')
      const inserted = await effect(key, 'effect')
      if (inserted.length > 0) {
        emit('effect-before-checkpoint', { key })
        await new Promise<never>(() => {})
      }
      return { once: true }
    })
  }
  const first = await step.do('list', async () => {
    await count(key, 'list')
    return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  })
  if (mode === 'sleep' || mode === 'fifo' || mode === 'pipeline') {
    emit('sleep-entered', { key })
    await step.sleep('first-sleep', params.sleepMs ?? 2_000)
  }
  if (mode === 'fifo') {
    const received = []
    for (const [index, type] of ['b', 'a', 'a'].entries()) {
      const event = await step.waitForEvent(`event-${index}`, { type, timeoutMs: 1_000 })
      received.push({
        payload: event.payload as JsonValue,
        type: event.type,
        date: event.timestamp instanceof Date,
        timestamp: event.timestamp.toISOString(),
      })
    }
    let timedOut = false
    try {
      await step.waitForEvent('event-exhausted', { type: 'a', timeoutMs: 150 })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'WORKFLOW_EVENT_TIMEOUT'))
        throw error
      timedOut = true
    }
    return { received, timedOut }
  }
  if (mode === 'wait' || mode === 'pipeline') {
    emit('wait-entered', { key })
    try {
      const event = await step.waitForEvent('deadline', {
        type: 'resume',
        timeoutMs: params.timeoutMs ?? 2_000,
      })
      if (mode === 'wait')
        return {
          timedOut: false,
          payload: event.payload as JsonValue,
          date: event.timestamp instanceof Date,
        }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'WORKFLOW_EVENT_TIMEOUT'))
        throw error
      if (mode === 'wait') return { timedOut: true }
      throw new Error('Pipeline resume event missing')
    }
  }
  if (mode === 'pipeline') {
    for (let offset = 0; offset < first.length; offset += 2) {
      await step.do(`quota-${offset}`, async () => {
        await count(key, `quota-${offset}`)
        await db.transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO test_workflow_effect(run_id,key,step)
            VALUES(${config.runId},${key},${`quota-${offset}`}) ON CONFLICT DO NOTHING`)
        })
        return null
      })
      for (const item of first.slice(offset, offset + 2)) {
        await step.do(`detail-${item}`, async () => {
          await count(key, `detail-${item}`)
          await effect(key, `detail-${item}`)
          return { item }
        })
      }
      await step.sleep(`rate-${offset}`, 100)
    }
    emit('second-sleep-entered', { key })
    await step.sleep('second-sleep', params.secondSleepMs ?? params.sleepMs ?? 2_000)
    const event = await step.waitForEvent('early-event', { type: 'early', timeoutMs: 1_000 })
    await step.do('merge', async () => {
      await count(key, 'merge')
      return first.length
    })
    return step.do('summary', async () => {
      await count(key, 'summary')
      return {
        total: first.length,
        date: event.timestamp instanceof Date,
        eventTimestamp: event.timestamp.toISOString(),
      }
    })
  }
  await step.do('finish', async () => {
    await count(key, 'finish')
    await effect(key, 'finish')
    return null
  })
  return { businessStatus: 'failed', total: first.length }
}

const engine = await createNodeJobEngine({
  database: engineDatabase,
  databaseUrl: url,
  executorId: config.executorId,
  applicationVersion: 'workflow-integration-v1',
  ownershipDirectory: config.ownershipDirectory,
  nativePoolMax: 3,
  shutdownTimeoutMs: 500,
  register(engine) {
    workflow = createNodeWorkflow<Params>({ engine, name: config.name, handler })
  },
  stopReceiving() {
    workflow.stopReceiving()
  },
})

process.on(
  'message',
  (message: {
    command: string
    requestId: number
    id?: string
    params?: Params
    type?: string
    payload?: JsonValue
    invalid?: string
    now?: string
    terminalRetentionMs?: number
  }) => {
    void (async () => {
      if (message.command === 'stop-receiving') {
        workflow.stopReceiving()
        return {}
      }
      if (message.command === 'create' || message.command === 'invalid-params') {
        const params =
          message.command === 'invalid-params'
            ? (invalid(message.invalid ?? 'date') as Params)
            : (message.params as Params)
        const instance = await workflow.create({
          ...(message.id === undefined ? {} : { id: message.id }),
          params,
        })
        return { id: instance.id }
      }
      if (message.command === 'cleanup')
        return cleanupNodeWorkflowEvents(db, {
          ...(message.now ? { now: new Date(message.now) } : {}),
          ...(message.terminalRetentionMs === undefined
            ? {}
            : { terminalRetentionMs: message.terminalRetentionMs }),
        })
      const instance = await workflow.get(message.id as string)
      if (message.command === 'status') return { state: await instance.status() }
      if (message.command === 'get') return { id: instance.id }
      if (message.command === 'terminate') {
        await instance.terminate()
        return {}
      }
      if (message.command === 'event') {
        await instance.sendEvent({
          type: message.type as string,
          payload: message.payload as JsonValue,
        })
        return {}
      }
      if (message.command === 'invalid-event') {
        await instance.sendEvent({ type: 'early', payload: invalid(message.invalid ?? 'date') })
        return {}
      }
      throw new Error('Unknown test command')
    })()
      .then((value) => process.send?.({ requestId: message.requestId, ...value }))
      .catch((error: unknown) => {
        const value = error as { code?: string; name?: string }
        process.send?.({
          requestId: message.requestId,
          error: { code: value.code, name: value.name },
        })
      })
  },
)
process.once('SIGTERM', () => {
  void engine
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
})
emit('ready')
