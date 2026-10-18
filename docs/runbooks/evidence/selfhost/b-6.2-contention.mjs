import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDb } from '../../../../packages/db/src/index.ts'
import { createNodeQueueProducer } from '../../../../packages/platform/src/node/job-queue.ts'
import {
  attempts,
  effects,
  prepareTestTables,
  until,
  worker,
} from '../../../../packages/platform/test/node/job-queue.helpers.ts'

const require = createRequire(resolve('packages/platform/package.json'))
const { sql } = require('drizzle-orm')
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 直接Node验收环境，不经过Turbo缓存
const url = process.env.TEST_JOB_DATABASE_URL
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 独占测试库迁移环境，仅由父进程注入
const migratorUrl = process.env.TEST_JOB_MIGRATOR_URL
assert.ok(url && migratorUrl)
const runId = randomUUID()
const directory = await mkdtemp(join(tmpdir(), 'b-accept-queue-contention-'))
const db = createDb(url, { max: 3 })
const name = `contention-${runId}-limited`
const independent = `contention-${runId}-independent`
const children = []
try {
  await prepareTestTables(migratorUrl)
  for (const id of ['a', 'b']) {
    const child = worker({
      runId,
      executorId: `contention-${runId}-${id}`,
      ownershipDirectory: directory,
      queues: [name, independent].map((name) => ({
        name,
        policy: { concurrency: 2, rateLimit: { limit: 3, periodMs: 10000 } },
      })),
    })
    children.push(child)
  }
  await Promise.all(children.map((child) => child.wait('ready')))
  await createNodeQueueProducer(db, name).producer.sendBatch(
    Array.from({ length: 14 }, (_, index) => ({
      body: {
        key: `contention-${index}`,
        holdMs: 1500,
        mode: index === 0 ? 'retry-once' : undefined,
      },
    })),
  )
  await createNodeQueueProducer(db, independent).producer.sendBatch([
    { body: { key: 'independent-0', holdMs: 1500 } },
    { body: { key: 'independent-1', holdMs: 1500 } },
  ])
  // 两publisher全程保持接收，不暂停或按worker分发消息。
  for (const child of children) child.send('start')
  await until(async () => {
    const rows = await db.execute(sql`SELECT state FROM job_engine.message WHERE queue=${name}`)
    return rows.length === 14 && rows.every((row) => row.state === 'acked')
  }, 120000)
  await until(async () => {
    const rows = await db.execute(
      sql`SELECT state FROM job_engine.message WHERE queue=${independent}`,
    )
    return rows.length === 2 && rows.every((row) => row.state === 'acked')
  })
  const rows = (await db.select().from(attempts)).filter((row) => row.queue === name)
  assert.equal(rows.length, 15)
  assert.equal(new Set(rows.map((row) => row.executorId)).size, 2)
  assert.deepEqual(
    rows
      .filter((row) => row.key === 'contention-0')
      .map((row) => row.attempt)
      .sort(),
    [1, 2],
  )
  const starts = await db.execute(
    sql`SELECT queue,message_id,batch_id,attempt,started_at FROM job_engine.start WHERE queue=${name} ORDER BY started_at`,
  )
  const times = starts.map((row) => new Date(row.started_at).getTime())
  const windows = times.map((time) => ({
    at: new Date(time).toISOString(),
    count: times.filter((candidate) => candidate >= time && candidate < time + 10000).length,
  }))
  for (const window of windows) assert.ok(window.count <= 3)
  const timeline = rows
    .flatMap((row) => [
      { at: row.startedAt.toISOString(), delta: 1 },
      { at: row.finishedAt.toISOString(), delta: -1 },
    ])
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.delta - b.delta)
  let active = 0
  let maxActive = 0
  for (const event of timeline) {
    active += event.delta
    event.active = active
    maxActive = Math.max(maxActive, active)
    assert.ok(active >= 0 && active <= 2)
  }
  const otherStarts = await db.execute(
    sql`SELECT queue,message_id,batch_id,attempt,started_at FROM job_engine.start WHERE queue=${independent} ORDER BY started_at`,
  )
  assert.equal(otherStarts.length, 2)
  assert.ok(
    Math.max(...otherStarts.map((row) => new Date(row.started_at).getTime())) - times[0] < 10000,
  )
  const effectRows = (await db.select().from(effects)).filter((row) => row.runId === runId)
  assert.equal(effectRows.length, 16)
  console.log(
    JSON.stringify({
      event: 'b.6.2.simultaneous_contention',
      runId,
      attempts: rows,
      starts,
      windows,
      timeline,
      maxActive,
      workers: [...new Set(rows.map((row) => row.executorId))],
      independentStarts: otherStarts,
      effectCount: effectRows.length,
    }),
  )
} finally {
  await Promise.all(children.map((child) => child.stop()))
  await db.close()
  await rm(directory, { recursive: true, force: true })
}
