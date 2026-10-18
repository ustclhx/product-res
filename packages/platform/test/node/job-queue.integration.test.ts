import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDb, jobDeadLetter, jobMessage, jobStart } from '@product-res/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateNodeJobEngine } from '../../src/node/job-engine-migrate.ts'
import { createNodeQueueProducer } from '../../src/node/job-queue.ts'
import {
  attempts,
  type Body,
  effects,
  prepareTestTables,
  until,
  type Worker,
  worker,
} from './job-queue.helpers.ts'

const url = process.env.TEST_JOB_DATABASE_URL
const migratorUrl = process.env.TEST_JOB_MIGRATOR_URL
if (!url || !migratorUrl)
  throw new Error('TEST_JOB_DATABASE_URL and TEST_JOB_MIGRATOR_URL are required')
const runId = randomUUID()
const db = createDb(url, { max: 4 })
const children = new Set<Worker>()
let ownershipDirectory: string
let counter = 0

beforeAll(async () => {
  ownershipDirectory = await mkdtemp(join(tmpdir(), 'product-res-job-engine-'))
  await prepareTestTables(migratorUrl)
  await migrateNodeJobEngine({ databaseUrl: migratorUrl, applicationRole: 'app' })
})
afterAll(async () => {
  await Promise.all([...children].map((child) => child.stop()))
  await db.delete(attempts).where(eq(attempts.runId, runId))
  await db.delete(effects).where(eq(effects.runId, runId))
  await db.close()
  await rm(ownershipDirectory, { recursive: true, force: true })
})

function queueName(label: string) {
  return `test-${runId}-${label}-${counter++}`
}
function producer(name: string) {
  return createNodeQueueProducer<Body>(db, name)
}
async function launch(
  names: string[],
  options: {
    executorId?: string
    fault?: 'claimed' | 'accepted' | undefined
    limited?: boolean
  } = {},
) {
  const child = worker({
    runId,
    ownershipDirectory,
    executorId: options.executorId ?? `worker-${randomUUID()}`,
    fault: options.fault,
    queues: names.map((name) => ({
      name,
      policy: options.limited
        ? {
            concurrency: 2,
            rateLimit: { limit: 3, periodMs: 10_000 },
          }
        : undefined,
    })),
  })
  children.add(child)
  await child.wait('ready')
  return child
}
async function delivered(name: string) {
  return db
    .select()
    .from(attempts)
    .where(and(eq(attempts.runId, runId), eq(attempts.queue, name)))
}
async function messages(name: string) {
  return db.select().from(jobMessage).where(eq(jobMessage.queue, name))
}
async function finished(name: string, count: number) {
  await until(async () => {
    const rows = await messages(name)
    return rows.length === count && rows.every((row) => row.finishedAt !== null)
  })
}

// 不做自动 skip：缺数据库、schema或原生引擎配置时明确失败。
describe('Node queue with real PostgreSQL and independent jobs processes', () => {
  it('uses the caller Drizzle transaction: uncommitted invisible, rollback absent, commit atomic', async () => {
    const name = queueName('transaction')
    const queue = producer(name)
    const child = await launch([name])
    child.send('start')
    let staged!: () => void
    let commit!: () => void
    const stagedPromise = new Promise<void>((resolve) => {
      staged = resolve
    })
    const commitPromise = new Promise<void>((resolve) => {
      commit = resolve
    })
    const transaction = db.transaction(async (tx) => {
      await tx.insert(effects).values({ runId, key: 'transaction-business' })
      await queue.transactionalEnqueue.enqueue(tx, { key: 'transaction-queue' })
      staged()
      await commitPromise
    })
    await stagedPromise
    try {
      await delay(6_000)
      expect(await delivered(name)).toHaveLength(0)
      expect(await messages(name)).toHaveLength(0)
    } finally {
      commit()
    }
    await transaction
    await finished(name, 1)
    expect(await delivered(name)).toHaveLength(1)
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(effects).values({ runId, key: 'rollback-business' })
        await queue.transactionalEnqueue.enqueue(tx, { key: 'rollback-queue' })
        throw new Error('Rollback deliberately')
      }),
    ).rejects.toThrow('Rollback deliberately')
    await delay(6_000)
    expect(await delivered(name)).toHaveLength(1)
    expect(
      await db
        .select()
        .from(effects)
        .where(and(eq(effects.runId, runId), eq(effects.key, 'rollback-business'))),
    ).toHaveLength(0)
    await child.stop()
  })

  it('delivers a real ten-message mixed batch and exhausts only its failed member on the production timeline', async () => {
    const name = queueName('mixed')
    const queue = producer(name)
    const child = await launch([name])
    await queue.producer.sendBatch(
      Array.from({ length: 10 }, (_, index) => ({
        body: {
          key: `mixed-${index}`,
          mode: index === 9 ? ('retry' as const) : undefined,
          privateContent: 'PRIVATE_BODY_MUST_NOT_APPEAR_IN_LOGS',
        },
      })),
    )
    child.send('start')
    await until(async () => (await delivered(name)).length >= 10)
    const first = await delivered(name)
    expect(first).toHaveLength(10)
    expect(new Set(first.map((row) => row.batchId)).size).toBe(1)
    expect(first.every((row) => row.batchSize === 10 && row.attempt === 1)).toBe(true)
    await until(
      async () =>
        (await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))).length === 1,
      1_050_000,
    )
    const rows = await delivered(name)
    const retry = rows
      .filter((row) => row.key === 'mixed-9')
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    expect(retry.map((row) => row.attempt)).toEqual([1, 2, 3, 4, 5, 6])
    for (const [index, seconds] of [30, 60, 120, 240, 480].entries()) {
      const previous = retry[index]
      const next = retry[index + 1]
      if (!previous || !next) throw new Error('Missing retry attempt')
      const elapsed = next.startedAt.getTime() - previous.startedAt.getTime()
      expect(elapsed).toBeGreaterThanOrEqual(seconds * 1_000)
      expect(elapsed).toBeLessThan(seconds * 1_000 + 15_000)
    }
    for (let index = 0; index < 9; index++)
      expect(rows.filter((row) => row.key === `mixed-${index}`)).toHaveLength(1)
    const dead = await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))
    expect(dead[0]).toMatchObject({ messageId: retry[0]?.messageId, attempts: 6 })
    expect(child.output()).not.toContain('PRIVATE_BODY_MUST_NOT_APPEAR_IN_LOGS')
    // 5次退避未到900秒，不把配置上限误称为实测900秒等待。
    console.info(
      JSON.stringify({
        event: 'test.job_queue.retry_timeline',
        attempts: retry.map((row) => ({
          attempt: row.attempt,
          startedAt: row.startedAt.toISOString(),
        })),
      }),
    )
    await child.stop()
  })

  it.each(['claimed', 'accepted', 'before-ack'] as const)(
    'recovers a real SIGKILL at %s without duplicate business effects',
    async (boundary) => {
      const name = queueName(boundary)
      const queue = producer(name)
      const executorId = `recover-${randomUUID()}`
      const child = await launch([name], {
        executorId,
        fault: boundary === 'before-ack' ? undefined : boundary,
      })
      await queue.producer.send({
        key: name,
        mode: boundary === 'before-ack' ? 'before-ack' : undefined,
      })
      if (boundary === 'claimed') {
        // 等真实5秒聚合窗后只claim，确保崩溃发生在已持久领取、尚未发布。
        await delay(5_100)
        child.send('claim', name)
      } else child.send('start')
      await child.wait(boundary)
      const before = await messages(name)
      expect(before).toHaveLength(1)
      const identity = before[0]?.id
      const timestamp = before[0]?.createdAt
      await child.stop('SIGKILL')
      const recovered = await launch([name], { executorId })
      recovered.send('start')
      await finished(name, 1)
      const after = await messages(name)
      expect(after[0]).toMatchObject({ id: identity, createdAt: timestamp })
      expect(
        await db
          .select()
          .from(effects)
          .where(and(eq(effects.runId, runId), eq(effects.key, name))),
      ).toHaveLength(1)
      if (boundary === 'before-ack')
        expect((await delivered(name)).length).toBeGreaterThanOrEqual(2)
      await recovered.stop()
    },
  )

  it('shares message permits and rolling rate windows across two jobs, including batch members, retries and independent queues', async () => {
    const name = queueName('limited')
    const independent = queueName('independent')
    const queue = producer(name)
    const other = producer(independent)
    const a = await launch([name, independent], { limited: true })
    const b = await launch([name, independent], { limited: true })
    await queue.producer.sendBatch(
      Array.from({ length: 8 }, (_, index) => ({
        body: {
          key: `limited-${index}`,
          holdMs: 1_500,
          mode: index === 0 ? ('retry-once' as const) : undefined,
        },
      })),
    )
    await other.producer.sendBatch([
      { body: { key: 'independent-0', holdMs: 1_500 } },
      { body: { key: 'independent-1', holdMs: 1_500 } },
    ])
    a.send('start')
    await a.wait('batch-started')
    a.send('pause')
    b.send('start')
    await until(async () => (await messages(name)).every((row) => row.finishedAt !== null), 90_000)
    await finished(independent, 2)
    const deliveries = await delivered(name)
    expect(deliveries).toHaveLength(9)
    expect(new Set(deliveries.map((row) => row.executorId)).size).toBe(2)
    expect(deliveries.some((row) => row.batchSize === 2)).toBe(true)
    expect(
      deliveries
        .filter((row) => row.key === 'limited-0')
        .map((row) => row.attempt)
        .sort(),
    ).toEqual([1, 2])
    const starts = await db.select().from(jobStart).where(eq(jobStart.queue, name))
    expect(starts).toHaveLength(9)
    const times = starts.map((row) => row.startedAt.getTime()).sort((x, y) => x - y)
    for (const time of times)
      expect(
        times.filter((candidate) => candidate >= time && candidate < time + 10_000).length,
      ).toBeLessThanOrEqual(3)
    const events = deliveries
      .flatMap((row) => [
        { at: row.startedAt.getTime(), delta: 1 },
        { at: row.finishedAt?.getTime() ?? Number.NaN, delta: -1 },
      ])
      .sort((x, y) => x.at - y.at || x.delta - y.delta)
    let active = 0
    let maxActive = 0
    for (const event of events) {
      active += event.delta
      maxActive = Math.max(maxActive, active)
      expect(active).toBeLessThanOrEqual(2)
    }
    const independentStarts = await db
      .select()
      .from(jobStart)
      .where(eq(jobStart.queue, independent))
    expect(independentStarts).toHaveLength(2)
    expect(
      Math.max(...independentStarts.map((row) => row.startedAt.getTime())) -
        (times[0] ?? Number.NaN),
    ).toBeLessThan(10_000)
    console.info(
      JSON.stringify({
        event: 'test.job_queue.global_permits',
        workers: new Set(deliveries.map((row) => row.executorId)).size,
        maxActive,
        starts: times.map((time) => new Date(time).toISOString()),
        independentStarts: independentStarts.map((row) => row.startedAt.toISOString()),
      }),
    )
    await Promise.all([a.stop(), b.stop()])
  })

  it('persists a valid nonretryable failure before acknowledgement and acknowledges invalid messages without dead letters or payload logs', async () => {
    const name = queueName('dead-letter')
    const queue = producer(name)
    const child = await launch([name])
    await queue.producer.sendBatch([
      {
        body: { key: 'valid-failure', mode: 'permanent', privateContent: 'SECRET_PERMANENT_BODY' },
      },
      { body: { key: 'invalid', mode: 'invalid', privateContent: 'SECRET_INVALID_BODY' } },
    ])
    child.send('start')
    await child.wait('dead-letter-recorded')
    const dead = await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ code: 'TEST_PERMANENT_FAILURE', attempts: 1 })
    await finished(name, 2)
    expect(await delivered(name)).toHaveLength(2)
    expect(child.output()).not.toContain('SECRET_PERMANENT_BODY')
    expect(child.output()).not.toContain('SECRET_INVALID_BODY')
    await child.stop()
  })
})
