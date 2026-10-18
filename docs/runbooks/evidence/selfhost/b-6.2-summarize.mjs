import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const input = resolve('test-results/b-accept-queue')
const output = resolve('docs/runbooks/evidence/selfhost')
const lines = (name) =>
  readFileSync(resolve(input, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const snapshots = lines('metadata.jsonl')
const workerEvents = lines('worker-events.jsonl')
const manifest = JSON.parse(readFileSync(resolve(input, 'manifest.json'), 'utf8'))
const keys = {
  attempts: (row) => `${row.run_id}:${row.message_id}:${row.attempt}:${row.executor_id}`,
  effects: (row) => `${row.run_id}:${row.key}`,
  messages: (row) => row.id,
  batches: (row) => row.id,
  starts: (row) => `${row.message_id}:${row.attempt}:${row.started_at}`,
  deadLetters: (row) => row.message_id,
  native: (row) => row.workflow_uuid,
}
const collected = Object.fromEntries(Object.keys(keys).map((key) => [key, new Map()]))
const histories = new Map()
for (const snapshot of snapshots) {
  for (const row of snapshot.rows) {
    collected[snapshot.table].set(keys[snapshot.table](row), row)
    if (snapshot.table === 'messages') {
      const history = histories.get(row.id) ?? []
      const state = {
        observedAt: snapshot.observedAt,
        state: row.state,
        attempts: row.attempts,
        batchId: row.batch_id,
        availableAt: row.available_at,
      }
      const previous = history.at(-1)
      if (
        !previous ||
        previous.state !== state.state ||
        previous.attempts !== state.attempts ||
        previous.batchId !== state.batchId
      )
        history.push(state)
      histories.set(row.id, history)
    }
  }
}
const data = Object.fromEntries(
  Object.entries(collected).map(([key, value]) => [key, [...value.values()]]),
)
const mixed = data.attempts.filter((row) => row.queue.includes('-mixed-'))
const retry = mixed.filter((row) => row.key === 'mixed-9').sort((a, b) => a.attempt - b.attempt)
assert.deepEqual(
  retry.map((row) => row.attempt),
  [1, 2, 3, 4, 5, 6],
)
assert.equal(mixed.length, 15)
assert.ok(mixed.filter((row) => row.attempt === 1).every((row) => row.batch_size === 10))
const mixedDeadLetter = data.deadLetters.find((row) => row.message_id === retry[0].message_id)
assert.equal(mixedDeadLetter?.attempts, 6)
assert.equal(mixedDeadLetter?.code, 'QUEUE_RETRIES_EXHAUSTED')
const transactionAttempts = data.attempts.filter((row) => row.queue.includes('-transaction-'))
assert.equal(transactionAttempts.length, 1)
assert.ok(data.effects.some((row) => row.key === 'transaction-business'))
assert.ok(data.effects.every((row) => row.key !== 'rollback-business'))
assert.ok(data.attempts.every((row) => row.key !== 'rollback-queue'))
for (let index = 0; index < 9; index++)
  assert.equal(mixed.filter((row) => row.key === `mixed-${index}`).length, 1)
assert.equal(new Set(mixed.filter((row) => row.attempt === 1).map((row) => row.batch_id)).size, 1)
const delays = retry.slice(1).map((row, index) => ({
  fromAttempt: index + 1,
  toAttempt: index + 2,
  configuredSeconds: [30, 60, 120, 240, 480][index],
  elapsedSeconds: (Date.parse(row.started_at) - Date.parse(retry[index].started_at)) / 1000,
}))
for (const item of delays)
  assert.ok(
    item.elapsedSeconds >= item.configuredSeconds &&
      item.elapsedSeconds < item.configuredSeconds + 15,
  )
const limited = data.attempts.filter((row) => row.queue.includes('-limited-'))
assert.equal(limited.length, 9)
assert.equal(new Set(limited.map((row) => row.executor_id)).size, 2)
const starts = data.starts.filter((row) => row.queue.includes('-limited-'))
assert.equal(starts.length, 9)
const times = starts.map((row) => Date.parse(row.started_at)).sort((a, b) => a - b)
const windows = times.map((time) => ({
  startedAt: new Date(time).toISOString(),
  startsInNext10s: times.filter((candidate) => candidate >= time && candidate < time + 10000)
    .length,
}))
for (const item of windows) assert.ok(item.startsInNext10s <= 3)
const concurrency = limited
  .flatMap((row) => [
    { at: row.started_at, delta: 1 },
    { at: row.finished_at, delta: -1 },
  ])
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.delta - b.delta)
let active = 0
let maxActive = 0
for (const event of concurrency) {
  active += event.delta
  maxActive = Math.max(maxActive, active)
  event.active = active
  assert.ok(active >= 0 && active <= 2)
}
const independent = data.starts.filter((row) => row.queue.includes('-independent-'))
assert.equal(independent.length, 2)
assert.ok(Math.max(...independent.map((row) => Date.parse(row.started_at))) - times[0] < 10000)
const failures = ['claimed', 'accepted', 'before-ack'].map((boundary) => {
  const attemptRows = data.attempts.filter((row) => row.queue.includes(`-${boundary}-`))
  const message = data.messages.find((row) => row.queue.includes(`-${boundary}-`))
  const effectRows = data.effects.filter((row) => row.key === message.queue)
  const events = workerEvents.filter((row) => row.queues.includes(message.queue))
  assert.equal(message.state, 'acked')
  assert.equal(effectRows.length, 1)
  assert.ok(events.some((row) => row.event === 'ipc' && row.boundary === boundary))
  assert.ok(events.some((row) => row.event === 'exit' && row.signal === 'SIGKILL'))
  if (boundary === 'before-ack') assert.ok(attemptRows.length >= 2)
  return {
    boundary,
    message,
    attempts: attemptRows,
    effectCount: effectRows.length,
    history: histories.get(message.id),
    events,
  }
})
assert.equal(manifest.exitCode, 0)
assert.equal(manifest.dbos, '5.2.11')
assert.equal(manifest.cleaned, true)
const contentionInput = resolve(input, 'contention')
const contentionManifest = JSON.parse(
  readFileSync(resolve(contentionInput, 'manifest.json'), 'utf8'),
)
assert.equal(contentionManifest.exitCode, 0)
assert.equal(contentionManifest.cleaned, true)
const contention = readFileSync(resolve(contentionInput, 'suite.log'), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map(JSON.parse)
  .find((row) => row.event === 'b.6.2.simultaneous_contention')
assert.ok(contention)
const contentionEvents = readFileSync(resolve(contentionInput, 'worker-events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse)
assert.equal(
  contentionEvents.filter((row) => row.event === 'command' && row.command === 'start').length,
  2,
)
assert.equal(
  contentionEvents.filter((row) => row.event === 'command' && row.command === 'pause').length,
  0,
)
assert.equal(contention.workers.length, 2)
assert.equal(contention.attempts.length, 15)
assert.ok(contention.maxActive <= 2)
assert.ok(contention.windows.every((row) => row.count <= 3))
// 正式原始观察包含maintenance套件；交付仅保留6.2队列域，原始记录以哈希留档。
const queueRunId = retry[0].run_id
const relevantMessages = data.messages.filter((row) => row.queue.startsWith(`test-${queueRunId}-`))
const relevantIds = new Set(relevantMessages.map((row) => row.id))
const relevantBatches = data.batches.filter((row) => row.queue.startsWith(`test-${queueRunId}-`))
const relevantWorkflowIds = new Set(relevantBatches.map((row) => `queue-batch:${row.id}`))
const scopedData = {
  attempts: data.attempts.filter((row) => row.run_id === queueRunId),
  effects: data.effects.filter((row) => row.run_id === queueRunId),
  messages: relevantMessages,
  batches: relevantBatches,
  starts: data.starts.filter((row) => relevantIds.has(row.message_id)),
  deadLetters: data.deadLetters.filter((row) => relevantIds.has(row.message_id)),
  native: data.native.filter((row) => relevantWorkflowIds.has(row.workflow_uuid)),
}
const rawArtifacts = [
  'manifest.json',
  'metadata.jsonl',
  'worker-events.jsonl',
  'suite.log',
  'setup-errors.log',
].map((name) => ({
  path: `test-results/b-accept-queue/${name}`,
  sha256: createHash('sha256')
    .update(readFileSync(resolve(input, name)))
    .digest('hex'),
}))
const evidence = {
  manifest,
  rawArtifacts,
  fullSuiteWorkerCount: workerEvents.filter((row) => row.event === 'spawn').length,
  fullSuiteExitedWorkerCount: workerEvents.filter((row) => row.event === 'exit').length,
  simultaneousContention: {
    manifest: contentionManifest,
    result: contention,
    workerEvents: contentionEvents,
  },
  summary: {
    transaction: {
      committedAttemptCount: transactionAttempts.length,
      rollbackAttemptCount: 0,
      rollbackBusinessCount: 0,
      committedAttempts: transactionAttempts,
    },
    mixedAttemptCount: mixed.length,
    mixedInitialBatchSize: 10,
    mixedSuccessCounts: Array.from({ length: 9 }, (_, index) => ({
      key: `mixed-${index}`,
      count: 1,
    })),
    retry,
    delays,
    mixedDeadLetter: data.deadLetters.find((row) => row.message_id === retry[0].message_id),
    limitedAttemptCount: limited.length,
    workerCount: 2,
    maxActive,
    windows,
    concurrency,
    independentStarts: independent,
    failures,
  },
  metadata: {
    ...scopedData,
    messageHistories: Object.fromEntries([...histories].filter(([id]) => relevantIds.has(id))),
  },
  workerEvents: workerEvents.filter((row) => row.runId === queueRunId),
}
writeFileSync(resolve(output, 'b-6.2-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
writeFileSync(
  resolve(output, 'b-6.2-suite.log'),
  `${readFileSync(resolve(input, 'suite.log'), 'utf8').replaceAll(process.cwd(), '<worktree>').trimEnd()}\n`,
)
console.log(
  JSON.stringify(
    {
      retry: retry.map(({ attempt, started_at }) => ({ attempt, started_at })),
      delays,
      limitedAttemptCount: limited.length,
      maxActive,
      failureWindows: failures.map(({ boundary, effectCount, attempts }) => ({
        boundary,
        effectCount,
        attemptCount: attempts.length,
      })),
    },
    null,
    2,
  ),
)
