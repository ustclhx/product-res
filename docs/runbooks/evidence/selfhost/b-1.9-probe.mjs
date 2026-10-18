// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: 运维探针直接在镜像内运行，不属于 Turbo 缓存任务。
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

// 在正式 migrate 镜像的 /src 执行，隔离库必须先完成正式业务与 DBOS 迁移。
// 不与生产 jobs 混用：本文件的注册集固定为 queue + long-sleep workflow v1。
// DATABASE_URL_FILE 是 app 密钥文件；migrator 使用 MIGRATION_DATABASE_URL_FILE。
// 两个 worker 要设置互异且重启不变的 --hostname 与 PROBE_EXECUTOR_ID，
// 共享挂载 PROBE_OWNERSHIP_DIRECTORY；不删除 ownership 记录来强行接管。
// produce 使用 worker1 的 hostname/executorId；produce 退出后才启动 worker1，
// 让同一 executor 恢复可能已在 produce 进程开始的持久 sleep。
// 使用：node --experimental-strip-types /tmp/b-1.9-probe.mjs migrator|produce|worker|retention
// retention 默认用真实 now；PROBE_CLEANUP_NOW 为 ISO 时间时明确输出 simulated=true。
// PROBE_REQUIRE_COMPLETE=1 要求 SUCCESS、两次 callback 各一次、事件年龄至少一小时。
// 模拟终态清理会删除 queue/event 证据，应先保存 require-complete 的输出。
// 1.9 使用更紧的 250ms 聚合窗观察 CPU/积压压力；这是隔离探针配置，
// 不作为 6.2 生产队列语义重验。正式双 jobs 仍采用生产默认 batchSize10/5000ms。

const mode = process.argv[2] ?? process.env.PROBE_MODE ?? 'worker'
const sourceRoot = process.env.PROBE_SOURCE_ROOT ?? '/src'
const runId = process.env.PROBE_RUN_ID ?? 'b19-20261015'
const queueName = 'budget-probe-v1'
const workflowName = 'budget-long-sleep-v1'
const applicationVersion = 'budget-probe-v1'
const businessId = `${runId}-long-sleep`
const workflowId = `workflow:${Buffer.from(workflowName).toString('base64url')}:${Buffer.from(businessId).toString('base64url')}`
const hour = 3_600_000
const sleepMs = 3_661_000
const secondBatch = process.env.PROBE_SECOND_BATCH === '1'
const expectedMessages = Number(process.env.PROBE_EXPECTED_MESSAGES ?? 90)
const emit = (event, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`)
const fail = (code) => Object.assign(new Error('Probe failed'), { code })
const errorCode = (error) =>
  typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.code)
    ? error.code
    : 'PROBE_UNKNOWN'

let db
let engine
let queue
let workflow
let closing = false

async function close() {
  if (closing) return
  closing = true
  await engine?.close()
  await db?.close()
}

async function main() {
  if (!['migrator', 'produce', 'worker', 'retention'].includes(mode))
    throw fail('PROBE_MODE_INVALID')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) throw fail('PROBE_RUN_INVALID')
  if (![90, 180].includes(expectedMessages)) throw fail('PROBE_EXPECTED_MESSAGES_INVALID')
  const secretFile =
    mode === 'migrator' ? process.env.MIGRATION_DATABASE_URL_FILE : process.env.DATABASE_URL_FILE
  if (!secretFile) throw fail('PROBE_DATABASE_FILE_MISSING')
  const databaseUrl = (await readFile(secretFile, 'utf8')).trim()
  const parsed = new URL(databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.pathname !== '/b_budget_probe'
  )
    throw fail('PROBE_DATABASE_NOT_ISOLATED')
  const moduleUrl = (relative) => pathToFileURL(`${sourceRoot}/${relative}`).href
  const require = createRequire(`${sourceRoot}/packages/platform/package.json`)
  // SQL 使用同一 ESM 包入口，避免从 /tmp 查找依赖或引入另一份 Drizzle。
  const drizzleEntry = require.resolve('drizzle-orm').replace(/\.cjs$/, '.js')
  const [{ createDb }, { sql }] = await Promise.all([
    import(moduleUrl('packages/db/src/client.ts')),
    import(pathToFileURL(drizzleEntry).href),
  ])
  const execute = (statement) => db.transaction((tx) => tx.execute(statement))
  db = createDb(databaseUrl, {
    max: 10,
    connection: {
      application_name: mode === 'migrator' ? 'budget_probe_migrator' : 'budget_probe_app',
    },
  })

  if (mode === 'migrator') {
    const role = process.env.PROBE_APP_ROLE ?? 'app'
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw fail('PROBE_ROLE_INVALID')
    await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS public.budget_effect (
        run_id text NOT NULL, kind text NOT NULL, key text NOT NULL,
        calls integer NOT NULL DEFAULT 1, executor_id text NOT NULL,
        first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz, metric_ms bigint,
        PRIMARY KEY (run_id,kind,key)
      )`)
      await tx.execute(
        sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.budget_effect TO "${role}"`),
      )
    })
    emit('probe.fixture_migrated', { tables: 1 })
    return
  }

  const executorId = process.env.PROBE_EXECUTOR_ID
  const ownershipDirectory = process.env.PROBE_OWNERSHIP_DIRECTORY
  if (!executorId || !/^[A-Za-z0-9_-]{1,80}$/.test(executorId) || !ownershipDirectory)
    throw fail('PROBE_OWNER_CONFIG_MISSING')
  // 容器 hostname 必须稳定；不同 executor 应使用不同容器 hostname。
  if (!hostname()) throw fail('PROBE_HOSTNAME_MISSING')
  const [engineModule, queueModule, workflowModule, queueCleanup, eventCleanup] = await Promise.all(
    [
      import(moduleUrl('packages/platform/src/node/job-engine.ts')),
      import(moduleUrl('packages/platform/src/node/job-queue.ts')),
      import(moduleUrl('packages/platform/src/node/workflow.ts')),
      import(moduleUrl('packages/platform/src/node/job-maintenance.ts')),
      import(moduleUrl('packages/platform/src/node/workflow-events.ts')),
    ],
  )

  async function effect(kind, key, metricMs = null) {
    const rows = await execute(sql`INSERT INTO public.budget_effect
      (run_id,kind,key,executor_id,metric_ms)
      VALUES (${runId},${kind},${key},${executorId},${metricMs})
      ON CONFLICT (run_id,kind,key) DO UPDATE SET
        calls=budget_effect.calls+1, executor_id=excluded.executor_id,
        last_at=clock_timestamp(), metric_ms=excluded.metric_ms
      RETURNING (extract(epoch FROM first_at)*1000)::bigint AS started_ms`)
    return Number(rows[0].started_ms)
  }

  engine = await engineModule.createNodeJobEngine({
    database: db,
    databaseUrl,
    executorId,
    applicationVersion,
    ownershipDirectory,
    nativePoolMax: 4,
    shutdownTimeoutMs: 500,
    register(current) {
      queue = queueModule.createNodeQueueAdapter({
        db,
        executorId,
        ownershipToken: current.ownershipToken,
        assertOwnership: () => current.assertOwnership(),
        isExecutorStopped: (id, token) => current.isExecutorStopped(id, token),
        pollIntervalMs: 250,
      })
      queue.register(
        queueName,
        async (batch) => {
          const outcomes = await Promise.allSettled(
            batch.messages.map(async (message) => {
              // body 全为本探针生成的 metadata，不调用邮件或任何外部 API。
              if (message.body.runId !== runId) throw fail('PROBE_RUN_MISMATCH')
              await effect('queue', message.body.key)
              await delay(100)
              await execute(sql`UPDATE public.budget_effect SET completed_at=clock_timestamp()
            WHERE run_id=${runId} AND kind='queue' AND key=${message.body.key}`)
              message.ack()
            }),
          )
          const failed = outcomes.find((outcome) => outcome.status === 'rejected')
          if (failed) throw failed.reason
        },
        {
          batchSize: 2,
          batchTimeoutMs: 250,
          maxRetries: 3,
          retryDelaySeconds: 1,
          maxRetryDelaySeconds: 5,
          concurrency: 2,
          rateLimit: { limit: 3, periodMs: 10_000 },
        },
      )
      workflow = workflowModule.createNodeWorkflow({
        engine: current,
        name: workflowName,
        async handler(params, step) {
          const startedMs = await step.do('before-long-sleep-v1', async () => {
            const started = await effect('workflow-before', params.runId)
            emit('probe.sleep_entered', { sleepMs })
            return started
          })
          await step.sleep('real-3661-second-sleep-v1', sleepMs)
          const event = await step.waitForEvent('consume-early-event-v1', {
            type: 'early',
            timeoutMs: 300_000,
          })
          await step.do('after-long-sleep-v1', async () => {
            const ageMs = Date.now() - event.timestamp.getTime()
            await effect('workflow-after', params.runId, ageMs)
            await effect('workflow-elapsed', params.runId, Date.now() - startedMs)
            emit('probe.sleep_finished', { eventAgeMs: ageMs, elapsedMs: Date.now() - startedMs })
            return null
          })
          return { completed: true }
        },
      })
    },
    async start() {
      await queue.prepare()
      if (mode === 'worker') queue.start()
    },
    stopReceiving() {
      queue?.stopReceiving()
      workflow?.stopReceiving()
    },
  })

  async function summary() {
    const [row] = await execute(sql`SELECT
      (SELECT count(*)::int FROM job_engine.message WHERE queue=${queueName}) AS messages,
      (SELECT count(*)::int FROM job_engine.message WHERE queue=${queueName} AND state='acked') AS acked,
      (SELECT count(*)::int FROM job_engine.message WHERE queue=${queueName} AND state='dead') AS dead,
      (SELECT count(*)::int FROM job_engine.message WHERE queue=${queueName} AND state IN ('pending','claimed','running')) AS active_messages,
      (SELECT count(*)::int FROM job_engine.batch WHERE queue=${queueName} AND state IN ('claimed','published','running')) AS active_batches,
      (SELECT count(*)::int FROM public.budget_effect WHERE run_id=${runId} AND kind='queue') AS queue_effects,
      (SELECT coalesce(sum(calls),0)::int FROM public.budget_effect WHERE run_id=${runId} AND kind='queue') AS queue_calls,
      (SELECT count(DISTINCT executor_id)::int FROM public.budget_effect WHERE run_id=${runId} AND kind='queue') AS queue_executors,
      (SELECT coalesce(sum(calls),0)::int FROM public.budget_effect WHERE run_id=${runId} AND kind='workflow-before') AS before_calls,
      (SELECT coalesce(sum(calls),0)::int FROM public.budget_effect WHERE run_id=${runId} AND kind='workflow-after') AS after_calls,
      (SELECT coalesce(max(metric_ms),0)::bigint FROM public.budget_effect WHERE run_id=${runId} AND kind='workflow-after') AS consumed_event_age_ms,
      (SELECT coalesce(max(metric_ms),0)::bigint FROM public.budget_effect WHERE run_id=${runId} AND kind='workflow-elapsed') AS workflow_elapsed_ms,
      (SELECT count(*)::int FROM job_engine.workflow_event WHERE workflow_id=${workflowId}) AS events,
      (SELECT count(*)::int FROM job_engine.workflow_event WHERE workflow_id=${workflowId} AND consumed_at IS NULL) AS unconsumed_events,
      (SELECT coalesce(max(extract(epoch FROM clock_timestamp()-created_at)*1000),0)::bigint FROM job_engine.workflow_event WHERE workflow_id=${workflowId}) AS oldest_event_age_ms,
      (SELECT count(*)::int FROM dbos.workflow_status WHERE workflow_uuid=${workflowId} AND status IN ('PENDING','ENQUEUED','DELAYED')) AS active_workflows,
      (SELECT count(*)::int FROM dbos.workflow_status WHERE workflow_uuid=${workflowId} AND status='SUCCESS') AS successful_workflows,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS database_connections,
      (SELECT coalesce(max((SELECT count(*) FROM job_engine.start b WHERE b.queue=a.queue
        AND b.started_at > a.started_at-interval '10 seconds' AND b.started_at <= a.started_at)),0)::int
        FROM job_engine.start a WHERE a.queue=${queueName}) AS max_starts_per_10s,
      (SELECT coalesce(max((SELECT count(*) FROM public.budget_effect b WHERE b.run_id=${runId}
        AND b.kind='queue' AND b.first_at<=a.first_at AND (b.completed_at IS NULL OR b.completed_at>a.first_at))),0)::int
        FROM public.budget_effect a WHERE a.run_id=${runId} AND a.kind='queue') AS max_callback_overlap`)
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
  }

  if (mode === 'produce') {
    const sender = queueModule.createNodeQueueProducer(db, queueName)
    // 用正式 transactionalEnqueue 与单一事务使重复 produce 不增加 90 条消息。
    const sent = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`INSERT INTO public.budget_effect
        (run_id,kind,key,executor_id) VALUES (${runId},'produced',${secondBatch ? 'full-profile-queue' : 'queue'},${executorId})
        ON CONFLICT DO NOTHING RETURNING calls`)
      if (!inserted.length) return 0
      for (let index = 0; index < 90; index++) {
        await sender.transactionalEnqueue.enqueue(tx, {
          runId,
          key: `message-${index + (secondBatch ? 90 : 0)}`,
          requestId: `${runId}-${index + (secondBatch ? 90 : 0)}`,
          idempotencyKey: `${runId}-${index + (secondBatch ? 90 : 0)}`,
          kind: 'resource-probe',
        })
      }
      return 90
    })
    if (secondBatch) {
      emit('probe.extra_produced', { enqueued: sent, ...(await summary()) })
      return
    }
    const instance = await workflow.create({
      id: businessId,
      params: { runId, requestId: `${runId}-workflow`, kind: 'resource-probe' },
    })
    const sentEvents =
      await execute(sql`SELECT count(*)::int AS count FROM job_engine.workflow_event
      WHERE workflow_id=${workflowId}`)
    if (!sentEvents[0].count)
      await instance.sendEvent({ type: 'early', payload: { kind: 'probe' } })
    emit('probe.produced', { enqueued: sent, sleepMs, ...(await summary()) })
    return
  }

  if (mode === 'retention') {
    const simulated = Boolean(process.env.PROBE_CLEANUP_NOW)
    const now = simulated ? new Date(process.env.PROBE_CLEANUP_NOW) : new Date()
    if (!Number.isFinite(now.getTime())) throw fail('PROBE_NOW_INVALID')
    const before = await summary()
    const activeMessages = await execute(sql`SELECT id::text AS id FROM job_engine.message
      WHERE queue=${queueName} AND state IN ('pending','claimed','running')`)
    const activeBatches = await execute(sql`SELECT id::text AS id FROM job_engine.batch
      WHERE queue=${queueName} AND state IN ('claimed','published','running')`)
    emit('probe.retention_before', { simulated, ...before })
    if (
      process.env.PROBE_REQUIRE_COMPLETE === '1' &&
      (before.successful_workflows !== 1 ||
        before.before_calls !== 1 ||
        before.after_calls !== 1 ||
        before.consumed_event_age_ms < hour ||
        before.workflow_elapsed_ms < sleepMs ||
        before.queue_effects !== expectedMessages ||
        before.queue_calls !== expectedMessages ||
        before.max_starts_per_10s > 3 ||
        before.max_callback_overlap > 2 ||
        before.dead !== 0)
    )
      throw fail('PROBE_COMPLETION_ASSERTION_FAILED')
    // 先确认两个公开入口均拒绝小于一小时的 retention。
    for (const [cleanup, expected] of [
      [queueCleanup.cleanupNodeQueues, 'QUEUE_RETENTION_INVALID'],
      [eventCleanup.cleanupNodeWorkflowEvents, 'WORKFLOW_RETENTION_INVALID'],
    ]) {
      let rejected = false
      try {
        await cleanup(db, { now, terminalRetentionMs: hour - 1 })
      } catch (error) {
        if (errorCode(error) !== expected) throw error
        rejected = true
      }
      if (!rejected) throw fail('PROBE_MINIMUM_RETENTION_FAILED')
    }
    const queues = await queueCleanup.cleanupNodeQueues(db, {
      now,
      terminalRetentionMs: hour,
      deadLetterRetentionMs: hour,
      startRetentionMs: hour,
    })
    const events = await eventCleanup.cleanupNodeWorkflowEvents(db, {
      now,
      terminalRetentionMs: hour,
    })
    const after = await summary()
    const retained = async (table, rows) => {
      if (!rows.length) return 0
      const [count] = await execute(sql`SELECT count(*)::int AS count FROM ${sql.raw(table)}
        WHERE id IN (${sql.join(
          rows.map((row) => sql`${row.id}::uuid`),
          sql`,`,
        )})`)
      return count.count
    }
    const retainedActiveMessages = await retained('job_engine.message', activeMessages)
    const retainedActiveBatches = await retained('job_engine.batch', activeBatches)
    const activeQueueRetained =
      retainedActiveMessages === activeMessages.length &&
      retainedActiveBatches === activeBatches.length
    // worker 同时运行会自然推进活动消息，queue 精确留存比较需暂停 worker 后执行。
    const activeWorkflowRetained =
      before.active_workflows === 0 ||
      (after.active_workflows === before.active_workflows && after.events === before.events)
    if (!activeWorkflowRetained || !activeQueueRetained) throw fail('PROBE_ACTIVE_RETENTION_FAILED')
    emit('probe.retention_after', {
      simulated,
      minimumRetentionRejected: 2,
      activeWorkflowRetained,
      activeQueueRetained,
      activeMessagesBefore: activeMessages.length,
      retainedActiveMessages,
      activeBatchesBefore: activeBatches.length,
      retainedActiveBatches,
      queueMessagesDeleted: queues.messagesDeleted,
      queueBatchesDeleted: queues.batchesDeleted,
      queueStartsDeleted: queues.startsDeleted,
      queueWorkflowsDeleted: queues.workflowsDeleted,
      queueBatchesRetained: queues.batchesRetained,
      eventsDeleted: events.eventsDeleted,
      waitsDeleted: events.waitsDeleted,
      ...after,
    })
    return
  }

  emit('probe.ready', {
    businessPoolMax: 10,
    nativePoolMax: 4,
    pollMs: 250,
    batchSize: 2,
    batchTimeoutMs: 250,
    concurrency: 2,
    rateLimit: 3,
    ratePeriodMs: 10_000,
  })
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void close()
        .then(() => process.exit(0))
        .catch((error) => {
          emit('probe.shutdown_failed', { code: errorCode(error) })
          process.exit(1)
        })
    })
  while (!closing) {
    const memory = process.memoryUsage()
    const cpu = process.cpuUsage()
    emit('probe.sample', {
      ...(await summary()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      maxRssKiB: process.resourceUsage().maxRSS,
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
    })
    await delay(10_000)
  }
}

try {
  await main()
  await close()
  process.exit(0)
} catch (error) {
  emit('probe.failed', { code: errorCode(error) })
  await close().catch(() => emit('probe.close_failed', { code: 'PROBE_CLOSE_FAILED' }))
  process.exit(1)
}
