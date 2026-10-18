import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import postgres from '../../../../packages/db/node_modules/postgres/src/index.js'
import {
  prepareSchedulerTestTables,
  schedulerWorker,
} from '../../../../packages/platform/test/node/scheduler.helpers.ts'

const acceptanceEnv = process.env

// 正式 helper 与 adapter 自主 start()，不调用 tick() 或指定 prepareAt。
Object.assign(
  process.env,
  parseEnv(readFileSync('test-results/b-accept-scheduler/autonomous.env', 'utf8')),
)
const directory = resolve('test-results/b-accept-scheduler/autonomous-owners')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const db = postgres(acceptanceEnv.TEST_JOB_DATABASE_URL, { max: 1 })
const scheduleId = `b-accept-autonomous-${randomUUID()}`
const runId = randomUUID()
const definition = {
  id: scheduleId,
  cron: '*/2 * * * * *',
  timeZone: 'Asia/Singapore',
  missedRun: 'skip',
  holdMs: 3200,
}
await prepareSchedulerTestTables(acceptanceEnv.TEST_JOB_MIGRATOR_URL)
const workers = [1, 2].map((i) =>
  schedulerWorker({
    runId,
    executorId: `b-accept-autonomous-${i}`,
    ownershipDirectory: directory,
    schedules: [definition],
  }),
)
const report = {
  startedAt: new Date().toISOString(),
  scheduleId,
  runId,
  definition,
  control: 'autonomous scheduler.start(); no tick or injected current date',
  snapshots: [],
}
const snapshot = async (label) => {
  const value = {
    label,
    at: new Date().toISOString(),
    runs: await db`select id,schedule_id,scheduled_at,state,executor_id,started_at,finished_at from job_engine.schedule_run where schedule_id=${scheduleId}`,
    attempts: await db`select * from test_scheduler_attempt where schedule_id=${scheduleId}`,
    effects: await db`select * from test_scheduler_effect where schedule_id=${scheduleId}`,
  }
  report.snapshots.push(value)
  return value
}
try {
  await Promise.all(workers.map((worker) => worker.wait('ready')))
  for (const worker of workers) worker.send('start')
  await Promise.all(workers.map((worker) => worker.wait('started')))
  const started = await Promise.race(workers.map((worker) => worker.wait('handler-started')))
  report.startedMessage = started
  const initial = await snapshot('first-handler-started')
  assert.equal(initial.runs.length, 1)
  assert.equal(initial.attempts.length, 1)
  assert.equal(Date.parse(started.scheduledAt) % 2000, 0)
  report.latenessMs =
    new Date(initial.attempts[0].started_at).getTime() - Date.parse(started.scheduledAt)
  assert.ok(report.latenessMs >= 0 && report.latenessMs < 1500)
  await delay(2300)
  const crossed = await snapshot('crossed-next-slot-while-running')
  assert.equal(crossed.runs.length, 1)
  assert.equal(crossed.attempts.length, 1)
  assert.equal(crossed.effects.length, 0)
  assert.ok(Date.parse(crossed.at) >= Date.parse(started.scheduledAt) + 2000)
  for (const worker of workers) worker.send('pause')
  await Promise.all(workers.map((worker) => worker.wait('paused')))
  const deadline = Date.now() + 10_000
  while (
    !(await db`select state from job_engine.schedule_run where schedule_id=${scheduleId}`).some(
      (run) => run.state === 'completed',
    )
  ) {
    if (Date.now() > deadline) throw new Error('Autonomous run did not complete')
    await delay(100)
  }
  const final = await snapshot('completed-after-stopping-new-receipts')
  assert.equal(final.runs.length, 1)
  assert.equal(final.attempts.length, 1)
  assert.equal(final.effects.length, 1)
  report.durationMs =
    new Date(final.attempts[0].finished_at).getTime() -
    new Date(final.attempts[0].started_at).getTime()
  assert.ok(report.durationMs >= 3200)
  report.passed = true
} finally {
  await Promise.all(workers.map((worker) => worker.stop()))
  await db.end()
  report.finishedAt = new Date().toISOString()
  writeFileSync(
    'docs/runbooks/evidence/selfhost/b-6.1-autonomous.json',
    `${JSON.stringify(report, null, 2)}\n`,
  )
}
console.log(
  JSON.stringify({
    scheduleId,
    passed: report.passed,
    latenessMs: report.latenessMs,
    durationMs: report.durationMs,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  }),
)
