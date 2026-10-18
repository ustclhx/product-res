import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  type Database,
  jobBatch,
  jobDeadLetter,
  jobMessage,
  jobQueue,
  jobStart,
} from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import { log, withLogContext } from '@product-res/shared/log'
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type {
  DatabaseTransaction,
  DeadLetterSink,
  QueueBatch,
  QueueFailure,
  QueueMessage,
  QueueProducer,
  QueueSendOptions,
  TransactionalEnqueue,
} from '../queue.ts'

export interface NodeQueuePolicy {
  batchSize: number
  batchTimeoutMs: number
  maxRetries: number
  retryDelaySeconds: number
  maxRetryDelaySeconds: number
  concurrency: number
  rateLimit?: { limit: number; periodMs: number }
}
export const defaultNodeQueuePolicy: NodeQueuePolicy = {
  batchSize: 10,
  batchTimeoutMs: 5_000,
  maxRetries: 5,
  retryDelaySeconds: 30,
  maxRetryDelaySeconds: 900,
  concurrency: 10,
}
type MessageRow = typeof jobMessage.$inferSelect
type Registration = {
  policy: NodeQueuePolicy
  handler: (batch: QueueBatch<unknown>, sink: DeadLetterSink<unknown>) => Promise<void>
}
export interface NodeQueueOptions {
  db: Database
  executorId: string
  ownershipToken: string
  assertOwnership: () => Promise<void>
  isExecutorStopped: (executorId: string, token?: string) => Promise<boolean>
  pollIntervalMs?: number
}
const terminal = ['SUCCESS', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'CANCELLED']
const active = ['claimed', 'published', 'running']
const workflowId = (id: string) => `queue-batch:${id}`
const invalid = () =>
  new AppError('QUEUE_CONFIG_INVALID', 'Invalid Node queue configuration', { status: 500 })
function delaySeconds(options?: QueueSendOptions) {
  const delay = options?.delaySeconds ?? 0
  if (!Number.isFinite(delay) || delay < 0) throw invalid()
  return delay
}
function metadata(body: unknown, key: string) {
  if (body && typeof body === 'object' && key in body) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  return null
}

/** 同一队列行锁串行化 claim/额度，不把 native workflow 数冒充消息数。 */
export function createNodeQueueAdapter(options: NodeQueueOptions) {
  const { db, executorId } = options
  const registrations = new Map<string, Registration>()
  const executing = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  let receiving = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling: Promise<void> | undefined
  let lastPollSucceeded = false
  const pollIntervalMs = options.pollIntervalMs ?? 250
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw invalid()

  async function lockQueue(tx: DatabaseTransaction, name: string) {
    await tx.select().from(jobQueue).where(eq(jobQueue.name, name)).for('update')
  }
  async function requireOwned(tx: DatabaseTransaction, batchId: string) {
    await options.assertOwnership()
    const [batch] = await tx.select().from(jobBatch).where(eq(jobBatch.id, batchId)).for('update')
    if (
      !batch ||
      batch.executorId !== executorId ||
      batch.executorToken !== options.ownershipToken ||
      batch.state !== 'running'
    )
      throw new AppError('QUEUE_OWNERSHIP_LOST', 'Queue execution ownership lost', { status: 503 })
    return batch
  }
  async function recordFailure(tx: DatabaseTransaction, row: MessageRow, failure: QueueFailure) {
    // 失败原因仅允许机器码；拒绝携带验证码/正文/驱动异常的任意字符串。
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(failure.code)) throw invalid()
    await tx
      .insert(jobDeadLetter)
      .values({
        messageId: row.id,
        queue: row.queue,
        attempts: row.attempts,
        code: failure.code,
        retryable: failure.retryable ? 1 : 0,
      })
      .onConflictDoNothing()
    await tx
      .update(jobMessage)
      .set({ state: 'dead', finishedAt: new Date() })
      .where(eq(jobMessage.id, row.id))
  }
  async function settle(row: MessageRow, action: 'ack' | 'retry', retry?: QueueSendOptions) {
    const policy = registrations.get(row.queue)?.policy
    if (!policy || !row.batchId) throw invalid()
    await db.transaction(async (tx) => {
      await requireOwned(tx, row.batchId as string)
      const [current] = await tx
        .select()
        .from(jobMessage)
        .where(eq(jobMessage.id, row.id))
        .for('update')
      if (
        current?.state !== 'running' ||
        current.batchId !== row.batchId ||
        current.attempts !== row.attempts
      )
        return
      if (action === 'ack') {
        await tx
          .update(jobMessage)
          .set({ state: 'acked', finishedAt: new Date() })
          .where(eq(jobMessage.id, row.id))
      } else if (row.attempts > policy.maxRetries) {
        await recordFailure(tx, row, { code: 'QUEUE_RETRIES_EXHAUSTED', retryable: true })
      } else {
        const seconds =
          retry?.delaySeconds === undefined
            ? Math.min(
                policy.maxRetryDelaySeconds,
                policy.retryDelaySeconds * 2 ** (row.attempts - 1),
              )
            : Math.min(policy.maxRetryDelaySeconds, delaySeconds(retry))
        await tx
          .update(jobMessage)
          .set({
            state: 'pending',
            batchId: null,
            availableAt: new Date(Date.now() + seconds * 1_000),
          })
          .where(eq(jobMessage.id, row.id))
      }
    })
  }

  async function runBatch(id: string) {
    executing.add(id)
    try {
      await options.assertOwnership()
      const rows = await db.transaction(async (tx) => {
        const [peek] = await tx.select().from(jobBatch).where(eq(jobBatch.id, id))
        if (!peek) return []
        await lockQueue(tx, peek.queue)
        const [batch] = await tx.select().from(jobBatch).where(eq(jobBatch.id, id)).for('update')
        if (!batch || !active.includes(batch.state)) return []
        if (
          batch.executorId &&
          batch.executorToken !== options.ownershipToken &&
          !(await options.isExecutorStopped(batch.executorId, batch.executorToken ?? undefined))
        )
          throw new AppError('QUEUE_OWNERSHIP_LOST', 'Queue batch belongs to another executor', {
            status: 503,
          })
        const registration = registrations.get(batch.queue)
        if (!registration) throw invalid()
        const pending = await tx
          .select()
          .from(jobMessage)
          .where(and(eq(jobMessage.batchId, id), inArray(jobMessage.state, ['claimed', 'running'])))
          .orderBy(asc(jobMessage.id))
        await tx
          .update(jobBatch)
          .set({ executorId, executorToken: options.ownershipToken })
          .where(eq(jobBatch.id, id))
        const now = new Date()
        const { rateLimit } = registration.policy
        if (rateLimit) {
          const [count] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(jobStart)
            .where(
              and(
                eq(jobStart.queue, batch.queue),
                gt(jobStart.startedAt, new Date(now.getTime() - rateLimit.periodMs)),
              ),
            )
          if ((count?.count ?? 0) + pending.length > rateLimit.limit) return null
        }
        await tx
          .update(jobBatch)
          .set({ state: 'running', executorId, executorToken: options.ownershipToken })
          .where(eq(jobBatch.id, id))
        const result: MessageRow[] = []
        for (const row of pending) {
          if (row.attempts > registration.policy.maxRetries) {
            await recordFailure(tx, row, { code: 'QUEUE_RECOVERY_EXHAUSTED', retryable: true })
            continue
          }
          const [updated] = await tx
            .update(jobMessage)
            .set({ state: 'running', attempts: row.attempts + 1 })
            .where(eq(jobMessage.id, row.id))
            .returning()
          if (!updated) throw invalid()
          await tx.insert(jobStart).values({
            queue: row.queue,
            messageId: row.id,
            batchId: id,
            attempt: updated.attempts,
            startedAt: now,
          })
          result.push(updated)
        }
        return result
      })
      if (rows === null) return false
      if (!rows.length) {
        await db
          .update(jobBatch)
          .set({ state: 'completed', finishedAt: new Date() })
          .where(and(eq(jobBatch.id, id), inArray(jobBatch.state, active)))
        return true
      }
      await options.assertOwnership()
      const registration = registrations.get(rows[0]?.queue as string)
      if (!registration) throw invalid()
      const decisions = new Map<string, Promise<void>>()
      const choose = (row: MessageRow, action: 'ack' | 'retry', retry?: QueueSendOptions) => {
        if (decisions.has(row.id)) return
        const promise = settle(row, action, retry)
        // 同步 ack/retry 契约不能返回 Promise；在批次出口统一等待，避免未处理拒绝。
        promise.catch(() => {})
        decisions.set(row.id, promise)
      }
      const messages = rows.map(
        (row): QueueMessage<unknown> => ({
          id: row.id,
          body: row.body,
          attempts: row.attempts,
          timestamp: row.createdAt,
          ack: () => choose(row, 'ack'),
          retry: (retry) => choose(row, 'retry', retry),
        }),
      )
      const sink: DeadLetterSink<unknown> = {
        async failed(message, failure) {
          const row = rows.find((row) => row.id === message.id)
          if (!row || row.attempts !== message.attempts || decisions.has(row.id)) throw invalid()
          const recording = db.transaction(async (tx) => {
            await requireOwned(tx, id)
            const [current] = await tx
              .select()
              .from(jobMessage)
              .where(eq(jobMessage.id, row.id))
              .for('update')
            if (
              current?.state === 'running' &&
              current.batchId === id &&
              current.attempts === row.attempts
            )
              await recordFailure(tx, row, failure)
          })
          decisions.set(row.id, recording)
          await recording
        },
      }
      const batch: QueueBatch<unknown> = {
        queue: registrationName(rows),
        messages,
        ackAll: () =>
          messages.forEach((message) => {
            message.ack()
          }),
        retryAll: (retry) =>
          messages.forEach((message) => {
            message.retry(retry)
          }),
      }
      await withLogContext({ jobId: id, executorId }, async () => {
        for (const row of rows)
          log.info('platform.queue.start', {
            messageId: row.id,
            queue: row.queue,
            attempt: row.attempts,
            requestId: row.requestId,
          })
        try {
          await registration.handler(batch, sink)
        } catch {
          // consumer 异常可能含正文/凭据，仅记固定事件，未确认成员继续按策略重试。
          log.warn('platform.queue.consumer_failed', { queue: batch.queue })
        }
        for (const row of rows) if (!decisions.has(row.id)) choose(row, 'retry')
        await Promise.all(decisions.values())
        await db.transaction(async (tx) => {
          await requireOwned(tx, id)
          await tx
            .update(jobBatch)
            .set({ state: 'completed', finishedAt: new Date() })
            .where(eq(jobBatch.id, id))
        })
      })
      return true
    } finally {
      executing.delete(id)
    }
  }
  const batchWorkflow = DBOS.registerWorkflow(
    async (id: string) => {
      // 准入等待也必须持久；重放后仍用同批次与逐消息状态。
      let admitted = false
      let step = 0
      while (!admitted) {
        admitted = await DBOS.runStep(() => runBatch(id), { name: `consume-${step}` })
        if (!admitted) await DBOS.sleepms(pollIntervalMs)
        step++
      }
    },
    { name: 'product-res-queue-batch-v1' },
  )

  function register<T>(
    name: string,
    handler: (batch: QueueBatch<T>, sink: DeadLetterSink<T>) => Promise<void>,
    overrides: Partial<NodeQueuePolicy> = {},
  ) {
    if (receiving || registrations.has(name) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name))
      throw invalid()
    const policy = { ...defaultNodeQueuePolicy, ...overrides }
    for (const value of [policy.batchSize, policy.concurrency, policy.maxRetryDelaySeconds])
      if (!Number.isSafeInteger(value) || value < 1) throw invalid()
    for (const value of [policy.batchTimeoutMs, policy.maxRetries, policy.retryDelaySeconds])
      if (!Number.isSafeInteger(value) || value < 0) throw invalid()
    if (policy.batchSize > 10 || policy.batchTimeoutMs > 5_000) throw invalid()
    if (
      policy.rateLimit &&
      (!Number.isSafeInteger(policy.rateLimit.limit) ||
        policy.rateLimit.limit < 1 ||
        !Number.isSafeInteger(policy.rateLimit.periodMs) ||
        policy.rateLimit.periodMs < 1)
    )
      throw invalid()
    registrations.set(name, { policy, handler: handler as Registration['handler'] })
    return createNodeQueueProducer<T>(db, name)
  }

  async function prepare() {
    for (const [name, { policy }] of registrations) {
      await db.insert(jobQueue).values({ name, policy }).onConflictDoNothing()
      const [existing] = await db.select().from(jobQueue).where(eq(jobQueue.name, name))
      if (JSON.stringify(existing?.policy) !== JSON.stringify(policy)) {
        // jsonb 对象键无顺序；通过 PG 比较，拒绝两 worker 使用不同队列策略。
        const [match] = await db
          .select({ matches: sql<boolean>`${jobQueue.policy} = ${JSON.stringify(policy)}::jsonb` })
          .from(jobQueue)
          .where(eq(jobQueue.name, name))
        if (!match?.matches) throw invalid()
      }
    }
  }
  async function claim(name: string) {
    if (stopped) return null
    await options.assertOwnership()
    const registration = registrations.get(name)
    if (!registration) throw invalid()
    return db.transaction(async (tx) => {
      await lockQueue(tx, name)
      const [used] = await tx
        .select({ count: sql<number>`coalesce(sum(${jobBatch.size}), 0)::int` })
        .from(jobBatch)
        .where(and(eq(jobBatch.queue, name), inArray(jobBatch.state, active)))
      const capacity = Math.min(
        registration.policy.batchSize,
        registration.policy.concurrency - (used?.count ?? 0),
        registration.policy.rateLimit?.limit ?? 10,
      )
      if (capacity < 1) return null
      const now = new Date()
      const rows = await tx
        .select()
        .from(jobMessage)
        .where(
          and(
            eq(jobMessage.queue, name),
            eq(jobMessage.state, 'pending'),
            lte(jobMessage.availableAt, now),
          ),
        )
        .orderBy(asc(jobMessage.availableAt), asc(jobMessage.id))
        .limit(capacity)
        .for('update', { skipLocked: true })
      const first = rows[0]
      if (
        !first ||
        (rows.length < capacity &&
          now.getTime() - Math.max(first.createdAt.getTime(), first.availableAt.getTime()) <
            registration.policy.batchTimeoutMs)
      )
        return null
      if (stopped) return null
      const id = newId()
      await tx.insert(jobBatch).values({ id, queue: name, size: rows.length })
      await tx
        .update(jobMessage)
        .set({ state: 'claimed', batchId: id })
        .where(
          inArray(
            jobMessage.id,
            rows.map((row) => row.id),
          ),
        )
      return id
    })
  }
  async function publish(id: string) {
    if (stopped) return
    await options.assertOwnership()
    const owned = await db.transaction(async (tx) => {
      const [peek] = await tx.select().from(jobBatch).where(eq(jobBatch.id, id))
      if (peek?.state !== 'claimed') return false
      await lockQueue(tx, peek.queue)
      const [batch] = await tx.select().from(jobBatch).where(eq(jobBatch.id, id)).for('update')
      if (batch?.state !== 'claimed' || stopped) return false
      if (
        batch.executorId &&
        batch.executorToken !== options.ownershipToken &&
        !(await options.isExecutorStopped(batch.executorId, batch.executorToken ?? undefined))
      )
        return false
      // 先持久记录 publisher incarnation；SDK 接受前/准入等待中失败也有可验证的退出身份。
      await tx
        .update(jobBatch)
        .set({ executorId, executorToken: options.ownershipToken })
        .where(eq(jobBatch.id, id))
      return true
    })
    if (!owned || stopped) return
    const handle = await DBOS.startWorkflow(batchWorkflow, { workflowID: workflowId(id) })(id)
    // SDK 已持久接受后的崩溃留 claimed 状态；下轮以相同 ID 重复发布。
    await db
      .update(jobBatch)
      .set({ state: 'published' })
      .where(and(eq(jobBatch.id, id), eq(jobBatch.state, 'claimed')))
    const work = handle.getResult().then(
      () => {},
      () => {},
    )
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  }
  async function repair(id: string) {
    const [batch] = await db.select().from(jobBatch).where(eq(jobBatch.id, id))
    if (!batch || !active.includes(batch.state)) return
    const status = await DBOS.getWorkflowStatus(workflowId(id))
    if (!status || !terminal.includes(status.status)) return
    const owner = batch.executorId ?? status.executorId
    const safe =
      owner === executorId && batch.executorToken === options.ownershipToken && !executing.has(id)
        ? true
        : owner !== undefined &&
          owner !== null &&
          (await options.isExecutorStopped(owner, batch.executorToken ?? undefined))
    if (!safe) return
    await db.transaction(async (tx) => {
      await lockQueue(tx, batch.queue)
      const [current] = await tx.select().from(jobBatch).where(eq(jobBatch.id, id)).for('update')
      if (!current || !active.includes(current.state)) return
      // 退出证明只适用于读取到的 incarnation；锁等待中恢复者可能已换 owner，不能释放其额度。
      if (current.executorId !== batch.executorId || current.executorToken !== batch.executorToken)
        return
      if (
        current.executorId === executorId &&
        current.executorToken === options.ownershipToken &&
        executing.has(id)
      )
        return
      const rows = await tx
        .select()
        .from(jobMessage)
        .where(and(eq(jobMessage.batchId, id), inArray(jobMessage.state, ['claimed', 'running'])))
        .for('update')
      const policy = registrations.get(batch.queue)?.policy
      if (!policy) throw invalid()
      for (const row of rows) {
        if (row.attempts > policy.maxRetries)
          await recordFailure(tx, row, { code: 'QUEUE_ENGINE_FAILED', retryable: true })
        else
          await tx
            .update(jobMessage)
            .set({
              state: 'pending',
              batchId: null,
              availableAt: new Date(
                Date.now() +
                  Math.min(
                    policy.maxRetryDelaySeconds,
                    policy.retryDelaySeconds * 2 ** Math.max(0, row.attempts - 1),
                  ) *
                    1_000,
              ),
            })
            .where(eq(jobMessage.id, row.id))
      }
      await tx
        .update(jobBatch)
        .set({ state: 'failed', finishedAt: new Date() })
        .where(eq(jobBatch.id, id))
    })
  }
  async function tick() {
    await options.assertOwnership()
    for (const name of registrations.keys()) {
      if (stopped) break
      const batches = await db
        .select()
        .from(jobBatch)
        .where(and(eq(jobBatch.queue, name), inArray(jobBatch.state, active)))
      for (const batch of batches) {
        if (stopped) break
        if (batch.state === 'claimed') await publish(batch.id)
        await repair(batch.id)
      }
      const id = await claim(name)
      if (id) await publish(id)
    }
    lastPollSucceeded = true
  }
  const stopReceiving = () => {
    stopped = true
    receiving = false
    clearTimeout(timer)
  }
  const loop = () => {
    if (!receiving) return
    polling = tick()
      .catch(() => {
        lastPollSucceeded = false
        log.error('platform.queue.poll_failed', { executorId })
      })
      .finally(() => {
        if (receiving) timer = setTimeout(loop, pollIntervalMs)
      })
  }
  return {
    register,
    prepare,
    claim,
    publish,
    repair,
    tick,
    stopReceiving,
    start() {
      if (receiving) return
      stopped = false
      receiving = true
      loop()
    },
    async health() {
      try {
        if (!DBOS.isInitialized()) return { status: 'down' as const }
        await options.assertOwnership()
        await db.select({ name: jobQueue.name }).from(jobQueue).limit(1)
        return { status: receiving && lastPollSucceeded ? ('up' as const) : ('down' as const) }
      } catch {
        return { status: 'down' as const }
      }
    },
    async drain(timeoutMs: number) {
      stopReceiving()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.all([polling, ...inFlight]).then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
/** Web 生产者无需启动 DBOS singleton；队列必须已由 jobs prepare 注册。 */
export function createNodeQueueProducer<T>(db: Database, name: string) {
  async function insert(tx: DatabaseTransaction | Database, body: T, delay = 0) {
    await tx.insert(jobMessage).values({
      id: newId(),
      queue: name,
      body,
      requestId: metadata(body, 'requestId'),
      idempotencyKey: metadata(body, 'idempotencyKey'),
      availableAt: new Date(Date.now() + delay * 1_000),
    })
  }
  const producer: QueueProducer<T> = {
    send: (body, options) => insert(db, body, delaySeconds(options)),
    sendBatch: (messages) =>
      db.transaction(async (tx) => {
        for (const message of messages) await insert(tx, message.body, delaySeconds(message))
      }),
  }
  return {
    producer,
    transactionalEnqueue: {
      enqueue: (tx, body) => insert(tx, body),
    } satisfies TransactionalEnqueue<T>,
  }
}
function registrationName(rows: MessageRow[]) {
  return rows[0]?.queue as string
}
