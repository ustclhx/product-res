import { env } from 'cloudflare:workers'
import {
  MEDIA_HOLD_SWEEP_BUFFER_MS,
  MEDIA_TASK_TTL_MS,
  type MediaProvider,
  mediaTaskHoldSweeper,
  settleMediaTask,
} from '@product-res/ai'
import { runHoldSweep } from '@product-res/billing'
import { getCreditBalance, grant, hold } from '@product-res/credits'
import {
  aiTask,
  createDb,
  creditHold,
  member,
  notification,
  organization,
  scoped,
  user,
} from '@product-res/db'
import type { WorkflowStep } from '@product-res/platform'
import { sql as query } from 'drizzle-orm'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { registerAiHoldSweepers } from '../src/ai.ts'
import { type MediaRunnerDeps, runMediaTask } from '../src/workflows/media-runner.ts'

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const id = () => crypto.randomUUID()
const workspaces: string[] = []
const unregister = registerAiHoldSweepers({ text: false, media: true })
afterAll(unregister)

async function fixture() {
  const workspaceId = id()
  const taskId = id()
  workspaces.push(workspaceId)
  await db.insert(user).values({
    id: workspaceId,
    name: 'Media sweep',
    email: `${workspaceId}@media-sweep.example.test`,
  })
  await db.insert(organization).values({ id: workspaceId, name: 'Media sweep', slug: workspaceId })
  await db
    .insert(member)
    .values({ id: id(), userId: workspaceId, organizationId: workspaceId, role: 'owner' })
  await grant(db, { workspaceId, source: 'admin', sourceRef: id(), amount: 100 })
  const startedAt = new Date(Date.now() - 3 * 60 * 60_000)
  const deadlineAt = new Date(startedAt.getTime() + MEDIA_TASK_TTL_MS)
  const reservation = await hold(db, {
    workspaceId,
    userId: workspaceId,
    amount: 15,
    refType: 'ai_task',
    refId: taskId,
    expiresAt: new Date(deadlineAt.getTime() + MEDIA_HOLD_SWEEP_BUFFER_MS),
  })
  await db.insert(aiTask).values({
    id: taskId,
    workspaceId,
    userId: workspaceId,
    kind: 'video',
    modelKey: 'frozen-video',
    pricing: { mode: 'per_unit', unit: 'second', perUnit: 3 },
    input: {
      params: {},
      providerModelId: 'fake/video',
      unitsLimit: 5,
      fileParams: [],
      storageBytes: 1000,
    },
    provider: 'fake',
    providerRequestKey: taskId,
    holdId: reservation.id,
    deadlineAt,
    createdAt: startedAt,
  })
  return { workspaceId, taskId, holdId: reservation.id }
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  const [reservation] = await sql<{ status: string; captured_amount: number }[]>`
    select status, captured_amount from credit_hold where id=${f.holdId}`
  const ledger = await sql<{ delta: number }[]>`
    select delta from credit_ledger where workspace_id=${f.workspaceId} and type='consume'`
  const notices = await sql<{ type: string }[]>`
    select type from notification where workspace_id=${f.workspaceId}`
  const [invariant] = await sql<{ valid: boolean }[]>`
    select (select coalesce(sum(delta),0) from credit_ledger where workspace_id=${f.workspaceId}) =
      (select coalesce(sum(remaining),0) from credit_grant where workspace_id=${f.workspaceId} and status='active') +
      (select coalesce(sum(amount),0) from credit_hold where workspace_id=${f.workspaceId} and status='held') -
      (select coalesce(sum(amount),0) from credit_debt where workspace_id=${f.workspaceId}) as valid`
  expect(invariant?.valid).toBe(true)
  return {
    task,
    hold: reservation,
    ledger,
    notices,
    balance: await getCreditBalance(db, f.workspaceId),
  }
}

async function sweep() {
  const result = await runHoldSweep(db)
  expect(result.failures.filter((failure) => workspaces.includes(failure.workspaceId))).toEqual([])
}

function lateRunner(options: { now?: number; onWait?: () => Promise<void> } = {}) {
  const provider = {
    id: 'fake',
    capabilities: { idempotentSubmit: false },
    submit: vi.fn<MediaProvider['submit']>(),
    getStatus: vi.fn<MediaProvider['getStatus']>(),
    parseWebhook: vi.fn<MediaProvider['parseWebhook']>(),
    cancel: vi.fn<NonNullable<MediaProvider['cancel']>>(async () => {
      throw new Error('Provider unavailable')
    }),
  } satisfies MediaProvider
  const persist = vi.fn<MediaRunnerDeps['persist']>()
  const stepDo = vi.fn(
    async (_name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) =>
      ((maybeCallback ?? configOrCallback) as () => Promise<unknown>)(),
  )
  const step = {
    do: stepDo,
    waitForEvent: vi.fn(async () => {
      await options.onWait?.()
      throw new Error('Event timeout')
    }),
    sleep: vi.fn(),
  } as unknown as WorkflowStep
  const deps: MediaRunnerDeps = {
    db,
    provider: () => provider,
    params: vi.fn(),
    callbackOrigin: 'https://app.example.test',
    callbackSecret: 'media-sweep-secret',
    persist,
    now: () => options.now ?? Date.now(),
  }
  return { provider, persist, step, stepDo, deps }
}

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR).$client
  for (const ws of workspaces) {
    await sql`delete from notification where workspace_id=${ws}`
    await sql`delete from ai_task where workspace_id=${ws}`
    await migrator`delete from audit_log where workspace_id=${ws}`
    await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id=${ws})`
    await sql`delete from credit_ledger where workspace_id=${ws}`
    await sql`delete from credit_hold where workspace_id=${ws}`
    await sql`delete from credit_grant where workspace_id=${ws}`
    await sql`delete from credit_debt where workspace_id=${ws}`
    await sql`delete from member where organization_id=${ws}`
    await sql`delete from organization where id=${ws}`
    await sql`delete from "user" where id=${ws}`
  }
})

it('refunds overdue queued and running tasks once; a late workflow stops even when provider cancellation fails', async () => {
  const queued = await fixture()
  const running = await fixture()
  await scoped(db, running.workspaceId).updateById(aiTask, running.taskId, {
    status: 'running',
    providerJobId: 'existing-job',
  })
  await sweep()
  await sweep()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const f of [queued, running]) {
    const before = await state(f)
    expect(before).toMatchObject({
      task: { status: 'failed', errorCode: 'MEDIA_DEADLINE_EXCEEDED', creditsCharged: 0 },
      hold: { status: 'released', captured_amount: 0 },
      ledger: [],
      notices: [{ type: 'ai_task.failed' }],
      balance: { available: 100, held: 0 },
    })
    const h = lateRunner()
    expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
      taskId: f.taskId,
      status: 'failed',
    })
    expect(h.provider.submit).not.toHaveBeenCalled()
    expect(h.provider.getStatus).not.toHaveBeenCalled()
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.step.waitForEvent).not.toHaveBeenCalled()
    expect(h.stepDo.mock.calls.map(([name]) => name)).toEqual(['load-task'])
    if (f === running) expect(h.provider.cancel).toHaveBeenCalledWith('existing-job')
    else expect(h.provider.cancel).not.toHaveBeenCalled()
    expect(await state(f)).toEqual(before)
  }
})

it('stops after a hold sweep during the callback wait without polling, persisting or repeating settlement', async () => {
  const f = await fixture()
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    status: 'running',
    providerJobId: 'waiting-job',
  })
  const task = (await state(f)).task
  let reclaimed: Awaited<ReturnType<typeof state>> | undefined
  const h = lateRunner({
    // Workflow 仍等待回调时，Cron 按数据库中的真实硬超时回收。
    now: task.deadlineAt.getTime() - 15 * 60_000,
    onWait: async () => {
      await sweep()
      reclaimed = await state(f)
    },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
    taskId: f.taskId,
    status: 'failed',
  })
  expect(h.step.waitForEvent).toHaveBeenCalledTimes(1)
  expect(h.stepDo.mock.calls.map(([name]) => name)).toEqual([
    'load-task',
    'submit',
    'check-callback',
  ])
  expect(h.provider.submit).not.toHaveBeenCalled()
  expect(h.provider.getStatus).not.toHaveBeenCalled()
  expect(h.persist).not.toHaveBeenCalled()
  expect(h.provider.cancel).toHaveBeenCalledWith('waiting-job')
  expect(reclaimed).toMatchObject({
    task: { status: 'failed', errorCode: 'MEDIA_DEADLINE_EXCEEDED', creditsCharged: 0 },
    hold: { status: 'released' },
    ledger: [],
    notices: [{ type: 'ai_task.failed' }],
    balance: { available: 100, held: 0 },
  })
  expect(await state(f)).toEqual(reclaimed)
})

it('repairs a completed success from its stored result and captures only once without repeating its notice', async () => {
  const f = await fixture()
  const result = { outputs: [], usage: { seconds: 3 } }
  const finishedAt = new Date(Date.now() - 60_000)
  await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
    status: 'succeeded',
    finishedAt,
    output: { files: [], result, usage: result.usage },
    callbackPayload: { jobId: 'old-job', result: { outputs: [], usage: { seconds: 5 } } },
  })
  await scoped(db, f.workspaceId).insert(notification, {
    userId: f.workspaceId,
    type: 'ai_task.succeeded',
    title: 'Already completed',
  })
  await sweep()
  const repaired = await state(f)
  expect(repaired).toMatchObject({
    task: { status: 'succeeded', creditsCharged: 9, output: { result }, finishedAt },
    hold: { status: 'captured', captured_amount: 9 },
    ledger: [{ delta: -9 }],
    notices: [{ type: 'ai_task.succeeded' }],
    balance: { available: 91, held: 0 },
  })
  await sweep()
  await settleMediaTask(db, { ...f, outcome: 'failed' })
  const h = lateRunner()
  expect(await runMediaTask(f.taskId, h.step, h.deps)).toEqual({
    taskId: f.taskId,
    status: 'succeeded',
  })
  expect(h.stepDo.mock.calls.map(([name]) => name)).toEqual(['load-task'])
  expect(await state(f)).toEqual(repaired)
})

it('releases stranded holds on failed and canceled terminal tasks without changing them or notifying again', async () => {
  const failed = await fixture()
  const canceled = await fixture()
  const originals = []
  for (const [f, status] of [
    [failed, 'failed'],
    [canceled, 'canceled'],
  ] as const) {
    await scoped(db, f.workspaceId).updateById(aiTask, f.taskId, {
      status,
      errorCode: 'ORIGINAL_REASON',
      finishedAt: new Date(Date.now() - 60_000),
      creditsCharged: 0,
    })
    originals.push({ f, task: (await state(f)).task })
  }
  await sweep()
  for (const { f, task } of originals) {
    expect(await state(f)).toMatchObject({
      task,
      hold: { status: 'released', captured_amount: 0 },
      ledger: [],
      notices: [],
      balance: { available: 100, held: 0 },
    })
  }
})

it('refunds in a sweep transaction while a successful workflow waits for the same workspace lock', async () => {
  const f = await fixture()
  const reservation = await scoped(db, f.workspaceId).findById(creditHold, f.holdId)
  let waitingPid = 0
  let late: Promise<unknown> | undefined
  try {
    await db.transaction(async (tx) => {
      // 先持有真实 billing 回收器的空间锁，再让 Workflow 并发尝试结算。
      await tx.execute(
        query`select pg_advisory_xact_lock(hashtextextended(${`ws:${f.workspaceId}`}, 0))`,
      )
      late = db
        .transaction(async (workflowTx) => {
          const [backend] = await workflowTx.execute<{ pid: number }>(
            query`select pg_backend_pid() as pid`,
          )
          waitingPid = backend?.pid ?? 0
          return settleMediaTask(
            db,
            {
              ...f,
              outcome: 'succeeded',
              result: { outputs: [], usage: { seconds: 3 } },
              files: [],
            },
            workflowTx,
          )
        })
        .then(
          (task) => ({ task }),
          (error: unknown) => ({ error }),
        )
      const waitUntil = Date.now() + 2000
      let waiting = false
      while (Date.now() < waitUntil) {
        const [row] = await sql<{ waiting: boolean }[]>`
          select exists(select 1 from pg_locks where pid=${waitingPid}
            and locktype='advisory' and not granted) as waiting`
        if (row?.waiting) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await mediaTaskHoldSweeper()({ db, tx, hold: reservation, now: new Date() })
    })
    expect(await late).toMatchObject({ task: { status: 'failed', creditsCharged: 0 } })
    expect(await state(f)).toMatchObject({
      task: { status: 'failed', errorCode: 'MEDIA_DEADLINE_EXCEEDED' },
      hold: { status: 'released' },
      ledger: [],
      notices: [{ type: 'ai_task.failed' }],
      balance: { available: 100, held: 0 },
    })
  } finally {
    await late
  }
})
