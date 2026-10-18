import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDb, jobBatch, jobDeadLetter, jobMessage, jobStart } from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateNodeJobEngine } from '../../src/node/job-engine-migrate.ts'
import { cleanupNodeQueues } from '../../src/node/job-maintenance.ts'
import { createNodeQueueProducer } from '../../src/node/job-queue.ts'
import { type Body, prepareTestTables, until, type Worker, worker } from './job-queue.helpers.ts'

const url = process.env.TEST_JOB_DATABASE_URL
const migratorUrl = process.env.TEST_JOB_MIGRATOR_URL
if (!url || !migratorUrl) throw new Error('Isolated job database variables required')
const db = createDb(url, { max: 3 })
const readonlyUrl = process.env.TEST_JOB_READONLY_DATABASE_URL
if (!readonlyUrl) throw new Error('Isolated readonly database variable required')
const readonly = createDb(readonlyUrl, { max: 1 })
const children = new Set<Worker>()
const runId = randomUUID()
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'job-lifecycle-'))
  await prepareTestTables(migratorUrl)
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
function spawnWorker(
  names: string[],
  id: string = randomUUID(),
  policy?: {
    batchSize: number
    batchTimeoutMs: number
    concurrency: number
    rateLimit: { limit: number; periodMs: number }
  },
) {
  const child = worker({
    runId,
    ownershipDirectory: directory,
    executorId: id,
    queues: names.map((name) => ({ name, policy })),
  })
  children.add(child)
  return child
}
async function launch(names: string[], id?: string) {
  const child = spawnWorker(names, id)
  await child.wait('ready')
  return child
}
async function state(name: string) {
  return db.select().from(jobMessage).where(eq(jobMessage.queue, name))
}
const queueName = () => `maintenance-${randomUUID()}`

describe('Node engine ownership, permissions and queue retention', () => {
  it('repeats migrator setup while app cannot create or alter and readonly sees metadata only', async () => {
    await migrateNodeJobEngine({
      databaseUrl: migratorUrl,
      applicationRole: 'app',
      readonlyRole: 'readonly',
    })
    const privileges = await db.execute<{ schema_create: boolean; db_create: boolean }>(sql`SELECT
      has_schema_privilege('app','dbos','CREATE') AS schema_create,
      has_database_privilege('app',current_database(),'CREATE') AS db_create`)
    expect(privileges[0]).toMatchObject({ schema_create: false, db_create: false })
    await expect(
      db.execute(sql`CREATE TABLE job_engine.test_forbidden(id int)`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(
      db.execute(sql`ALTER TABLE job_engine.message ADD COLUMN test_forbidden int`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
    await readonly.execute(sql`SELECT id,queue,attempts,state FROM job_engine.message LIMIT 1`)
    await readonly.execute(sql`SELECT workflow_uuid,status FROM dbos.workflow_status LIMIT 1`)
    await expect(
      readonly.execute(sql`SELECT body FROM job_engine.message LIMIT 1`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(
      readonly.execute(sql`UPDATE job_engine.message SET state='acked' WHERE false`),
    ).rejects.toMatchObject({ cause: { code: '42501' } })
  })

  it('retains active permits, pending messages and other workflows with unconsumed events across the 60-minute cleanup boundary', async () => {
    const name = queueName()
    const child = await launch([name])
    const queue = createNodeQueueProducer<Body>(db, name)
    await queue.producer.sendBatch([
      { body: { key: `${name}-acked` } },
      { body: { key: `${name}-dead`, mode: 'permanent' } },
      { body: { key: `${name}-active`, mode: 'before-ack' } },
    ])
    child.send('start')
    await child.wait('before-ack')
    await child.wait('dead-letter-recorded')
    child.send('pause')
    await child.wait('paused')
    await until(async () => (await state(name)).filter((row) => row.finishedAt).length === 2)
    await queue.producer.send({ key: `${name}-pending` }, { delaySeconds: 365 * 86_400 })
    const foreignId = `foreign:${randomUUID()}`
    child.send('foreign', foreignId)
    await child.wait('foreign-started')
    const beforeEvents = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM dbos.notifications WHERE destination_uuid=${foreignId} AND consumed=false`,
    )
    expect(beforeEvents[0]?.count).toBe(1)
    const hour = 3_600_000
    const current = new Date()
    child.send(
      'cleanup',
      JSON.stringify({
        now: new Date(current.getTime() + hour - 1_000).toISOString(),
        terminalRetentionMs: hour,
        deadLetterRetentionMs: hour,
        startRetentionMs: hour,
      }),
    )
    await child.wait('cleaned')
    expect(await state(name)).toHaveLength(4)
    child.send(
      'cleanup',
      JSON.stringify({
        now: new Date(current.getTime() + 31 * 86_400_000).toISOString(),
        terminalRetentionMs: hour,
        deadLetterRetentionMs: hour,
        startRetentionMs: hour,
      }),
    )
    await child.wait('cleaned')
    // ack/dead 成员仍属于未退出callback的active批次，不能因其单条终态释放批次/日志。
    expect(await state(name)).toHaveLength(4)
    expect(await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))).toHaveLength(
      1,
    )
    expect(await db.select().from(jobStart).where(eq(jobStart.queue, name))).toHaveLength(3)
    const afterEvents = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM dbos.notifications WHERE destination_uuid=${foreignId} AND consumed=false`,
    )
    expect(afterEvents[0]?.count).toBe(1)
    expect(child.output()).not.toContain('SECRET_EARLY_EVENT')
    await child.stop('SIGKILL')
    await expect(cleanupNodeQueues(db, { terminalRetentionMs: hour - 1 })).rejects.toMatchObject({
      code: 'QUEUE_RETENTION_INVALID',
    })
  })

  it('cleans terminal data at the retention boundary while retaining DLQ until its longer policy', async () => {
    const name = queueName()
    const child = await launch([name])
    const queue = createNodeQueueProducer<Body>(db, name)
    await queue.producer.sendBatch([
      { body: { key: `${name}-ok` } },
      { body: { key: `${name}-dead`, mode: 'permanent' } },
    ])
    child.send('start')
    await until(
      async () =>
        (await state(name)).length === 2 &&
        (await state(name)).every((row) => row.finishedAt !== null),
    )
    await until(
      async () =>
        (
          await db
            .select()
            .from(jobBatch)
            .where(and(eq(jobBatch.queue, name), eq(jobBatch.state, 'completed')))
        ).length === 1,
    )
    child.send('pause')
    await child.wait('paused')
    const hour = 3_600_000
    const boundary = Date.now()
    child.send(
      'cleanup',
      JSON.stringify({
        now: new Date(boundary + hour - 1_000).toISOString(),
        terminalRetentionMs: hour,
      }),
    )
    await child.wait('cleaned')
    expect(await state(name)).toHaveLength(2)
    child.send(
      'cleanup',
      JSON.stringify({
        now: new Date(boundary + hour + 1_000).toISOString(),
        terminalRetentionMs: hour,
      }),
    )
    await child.wait('cleaned')
    const retained = await state(name)
    expect(retained).toHaveLength(1)
    expect(retained[0]?.state).toBe('dead')
    expect(await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))).toHaveLength(
      1,
    )
    child.send('cleanup', new Date(Date.now() + 31 * 86_400_000).toISOString())
    await child.wait('cleaned')
    expect(await state(name)).toHaveLength(0)
    expect(await db.select().from(jobDeadLetter).where(eq(jobDeadLetter.queue, name))).toHaveLength(
      0,
    )
    expect(await db.select().from(jobBatch).where(eq(jobBatch.queue, name))).toHaveLength(0)
    await child.stop()
  })

  it('does not reclaim cancelled active callbacks; a confirmed exited owner repairs the failed batch without lost messages', async () => {
    const name = queueName()
    const id = `owned-${randomUUID()}`
    const child = await launch([name], id)
    const queue = createNodeQueueProducer<Body>(db, name)
    await queue.producer.send({ key: name, mode: 'before-ack' })
    child.send('start')
    await child.wait('before-ack')
    const [message] = await state(name)
    child.send('cancel', `queue-batch:${message?.batchId}`)
    await child.wait('cancelled')
    await delay(1_000)
    expect((await state(name))[0]?.state).toBe('running')
    // close 返回也不能证明 pause 中的callback退出；同ID新incarnation必须拒绝。
    child.send('close')
    await child.wait('engine-closed')
    const duplicate = spawnWorker([name], id)
    await until(async () => duplicate.child.exitCode !== null)
    expect(duplicate.child.exitCode).toBe(1)
    await child.stop('SIGKILL')
    const recovered = await launch([name])
    recovered.send('start')
    await until(async () => (await state(name))[0]?.state === 'acked', 45_000)
    expect((await state(name))[0]?.attempts).toBe(2)
    await recovered.stop()
  })

  it('recovers a cancelled rate-wait batch after restarting the same executor incarnation', async () => {
    const name = queueName()
    const id = `rate-owner-${randomUUID()}`
    const policy = {
      batchSize: 1,
      batchTimeoutMs: 0,
      concurrency: 1,
      rateLimit: { limit: 1, periodMs: 10_000 },
    }
    const child = spawnWorker([name], id, policy)
    await child.wait('ready')
    const queue = createNodeQueueProducer<Body>(db, name)
    await queue.producer.sendBatch([
      { body: { key: `${name}-first` } },
      { body: { key: `${name}-waiting` } },
    ])
    child.send('start')
    await until(async () => (await state(name)).some((row) => row.state === 'claimed'))
    child.send('pause')
    await child.wait('paused')
    const waiting = (await state(name)).find((row) => row.state === 'claimed')
    const [batch] = await db
      .select()
      .from(jobBatch)
      .where(eq(jobBatch.id, waiting?.batchId as string))
    expect(batch?.executorId).toBe(id)
    expect(batch?.executorToken).toBeTruthy()
    child.send('cancel', `queue-batch:${waiting?.batchId}`)
    await child.wait('cancelled')
    await child.stop('SIGKILL')
    const recovered = spawnWorker([name], id, policy)
    await recovered.wait('ready')
    recovered.send('start')
    await until(async () => (await state(name)).every((row) => row.state === 'acked'), 45_000)
    const [oldBatch] = await db
      .select()
      .from(jobBatch)
      .where(eq(jobBatch.id, waiting?.batchId as string))
    expect(oldBatch?.state).toBe('failed')
    expect((await state(name)).every((row) => row.attempts === 1)).toBe(true)
    await recovered.stop()
  })

  it('fails closed after ownership changes while the old process remains alive', async () => {
    const name = queueName()
    const id = `lost-${randomUUID()}`
    const child = await launch([name], id)
    child.send('start')
    const key = createHash('sha256').update(`product-res-job-engine:${id}`).digest('hex')
    const path = join(directory, `${key}.json`)
    const owner = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...owner, token: 'lost-owner' }))
    await until(async () => child.output().includes('platform.job_engine.ownership_lost'))
    const duplicate = spawnWorker([name], id)
    await until(async () => duplicate.child.exitCode !== null)
    expect(duplicate.child.exitCode).toBe(1)
    await child.stop('SIGKILL')
  })

  it('refuses a live or unknown recovery guard and recovers only a trusted exited Linux owner', async () => {
    const name = queueName()
    const id = `guard-${randomUUID()}`
    const child = await launch([name], id)
    const key = createHash('sha256').update(`product-res-job-engine:${id}`).digest('hex')
    const path = join(directory, `${key}.json`)
    const owner = await readFile(path, 'utf8')
    const guard = `${path}.recovering`
    await writeFile(guard, owner, { flag: 'wx' })
    child.send('close')
    await child.wait('engine-closed')
    const liveDuplicate = spawnWorker([name], id)
    await until(async () => liveDuplicate.child.exitCode !== null)
    expect(liveDuplicate.child.exitCode).toBe(1)
    await child.stop('SIGKILL')
    await writeFile(guard, '{}')
    const unknownDuplicate = spawnWorker([name], id)
    await until(async () => unknownDuplicate.child.exitCode !== null)
    expect(unknownDuplicate.child.exitCode).toBe(1)
    expect(await readFile(guard, 'utf8')).toBe('{}')
    expect(await readFile(path, 'utf8')).toBe(owner)
    await writeFile(guard, owner)
    const stoppedDuplicate = spawnWorker([name], id)
    if (process.platform === 'linux') {
      await stoppedDuplicate.wait('ready')
      expect(await readFile(path, 'utf8')).not.toBe(owner)
      await expect(readFile(guard, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await stoppedDuplicate.stop()
    } else {
      await until(async () => stoppedDuplicate.child.exitCode !== null)
      expect(stoppedDuplicate.child.exitCode).toBe(1)
      expect(await readFile(guard, 'utf8')).toBe(owner)
      expect(await readFile(path, 'utf8')).toBe(owner)
    }
  })
})
