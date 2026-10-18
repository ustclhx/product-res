import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import postgres from '../../../../packages/db/node_modules/postgres/src/index.js'

const acceptanceEnv = process.env

const temporary = resolve('test-results/b-accept-scheduler')
const environment = parseEnv(readFileSync(resolve(temporary, 'health.env'), 'utf8'))
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const evidenceFile = resolve('docs/runbooks/evidence/selfhost/b-6.1-health.json')
const report = { startedAt: new Date().toISOString(), sha, node: process.version, checkpoints: [] }
const db = postgres(environment.DATABASE_URL, { max: 2 })
const children = []
const emit = (event, data = {}) => {
  const record = { event, at: new Date().toISOString(), ...data }
  report.checkpoints.push(record)
  writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(record))
}
const launch = (name, args, env, ipc = false, cwd = process.cwd()) => {
  const log = createWriteStream(resolve(temporary, `${name}.log`), { mode: 0o600 })
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push(child)
  return child
}
const until = async (check, timeout = 350_000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Acceptance condition timeout')
    for (const child of children)
      if (child.exitCode !== null) throw new Error('Acceptance process exited')
    await delay(500)
  }
}
const health = async () => {
  const response = await fetch('http://127.0.0.1:30461/api/health')
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json(),
  }
}
const latest = async () =>
  await db`select scheduled_at,state,started_at,finished_at,id,executor_id from job_engine.schedule_run where schedule_id='jobs-heartbeat-v1' order by scheduled_at desc`
const acl = (permission) =>
  execFileSync(
    'docker',
    ['exec', 'b-accept-scheduler-valkey', 'valkey-cli', 'ACL', 'SETUSER', 'default', permission],
    { stdio: 'ignore' },
  )
try {
  mkdirSync(resolve(temporary, 'owners'), { recursive: true, mode: 0o700 })
  const jobs = [1, 2].map((i) =>
    launch(
      `health-jobs-${i}`,
      ['docs/runbooks/evidence/selfhost/b-6.1-health-harness.mjs'],
      {
        ...environment,
        HOST: '127.0.0.1',
        PORT: String(31460 + i),
        JOB_EXECUTOR_ID: `b-accept-scheduler-jobs-${i}`,
        JOB_OWNERSHIP_DIRECTORY: resolve(temporary, 'owners'),
        ACCEPT_BUILD_SHA: sha,
      },
      true,
    ),
  )
  await Promise.all(
    jobs.map(async (child) => {
      for (;;) {
        const [message] = await once(child, 'message')
        if (message.event === 'ready') return
      }
    }),
  )
  launch(
    'health-web',
    ['.output/server/index.mjs'],
    {
      ...environment,
      HOST: '127.0.0.1',
      PORT: '30461',
      JOBS_URL: 'http://127.0.0.1:31461',
    },
    false,
    resolve('apps/web'),
  )
  await until(
    async () =>
      fetch('http://127.0.0.1:30461/internal/live').then(
        (r) => r.status === 200,
        () => false,
      ),
    15_000,
  )
  const initial = await health()
  if (acceptanceEnv.ACCEPT_RESUME !== '1') assert.equal(initial.status, 503)
  assert.equal(initial.cache, 'no-store')
  if (acceptanceEnv.ACCEPT_RESUME !== '1') assert.equal(initial.body.jobs.lastCronAt, null)
  assert.equal(initial.body.version, sha)
  emit(acceptanceEnv.ACCEPT_RESUME === '1' ? 'resumed-observation' : 'initial-null', {
    health: initial,
    jobsPids: jobs.map((child) => child.pid),
  })
  await until(async () => (await health()).status === 200)
  const success = await health()
  const succeededAt = success.body.jobs.lastCronAt
  assert.equal(success.cache, 'no-store')
  emit('real-five-minute-success', { health: success, ledger: await latest() })
  // 隔离库准备真实删除补偿清单，Valkey ACL 只拒绝 DEL；PING 与其他探活保持正常。
  const cleanupId = randomUUID()
  await db`insert into verification (id,identifier,value,expires_at,created_at,updated_at) values (${cleanupId},${`deletion-cleanup:${cleanupId}`},'["b-accept-cache-key"]',now()+interval '1 hour',now(),now())`
  acl('-del')
  emit('deletion-compensation-failure-armed')
  await until(async () => (await latest()).some((run) => run.state === 'failed'))
  const failed = await health()
  assert.equal(failed.body.jobs.lastCronAt, succeededAt)
  assert.equal(failed.cache, 'no-store')
  assert.equal(failed.body.cache.status, 'up')
  emit('failed-precondition-no-advance', { health: failed, ledger: await latest() })
  acl('+del')
  const paused = await Promise.all(
    jobs.map(async (child) => {
      const response = once(child, 'message')
      child.send({ command: 'pause' })
      return (await response)[0]
    }),
  )
  emit('scheduler-stopped', { paused, succeededAt })
  const pauseStart = Date.now()
  while (Date.now() - pauseStart < 601_000) {
    await delay(Math.min(30_000, 601_000 - (Date.now() - pauseStart)))
    const elapsedMs = Date.now() - pauseStart
    emit('stopped-clock-observation', { elapsedMs, health: await health() })
  }
  const stale = await health()
  assert.equal(stale.status, 503)
  assert.equal(stale.cache, 'no-store')
  assert.equal(stale.body.jobs.lastCronAt, succeededAt)
  assert.ok(Date.now() - Date.parse(succeededAt) > 600_000)
  emit('stopped-over-ten-minutes-stale', {
    stoppedElapsedMs: Date.now() - pauseStart,
    heartbeatAgeMs: Date.now() - Date.parse(succeededAt),
    health: stale,
    ledger: await latest(),
  })
  report.passed = true
} catch (error) {
  report.passed = false
  emit('acceptance-failed', { code: error.code ?? 'ACCEPTANCE_FAILED', message: error.message })
  process.exitCode = 1
} finally {
  acl('+del')
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue
    const exit = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await exit
    clearTimeout(timer)
  }
  await db.end()
  report.finishedAt = new Date().toISOString()
  writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`)
}
