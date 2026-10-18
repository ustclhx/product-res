import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type MediaProvider, type MediaResult, mediaCallbackUrl } from '@product-res/ai'
import { getCreditBalance, grant, hold } from '@product-res/credits'
import {
  aiTask,
  createDb,
  jobWorkflowWait,
  member,
  organization,
  scoped,
  session,
  user,
} from '@product-res/db'
import { MEDIA_DONE_EVENT, newId } from '@product-res/shared'
import { createNodeStorage } from '@product-res/storage/node'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import {
  handleMediaCancel,
  handleMediaWebhook,
  type MediaHttpDeps,
} from '../../web/src/features/ai/media-tasks.ts'
import { createNodeMediaWorkflowClient } from '../../web/src/node/media-workflow.ts'
import { startMediaS3Fixture } from './fixtures/media-s3.ts'
import { startMediaWorker } from './fixtures/media-worker.helpers.ts'

const databaseUrl = process.env.TEST_JOB_DATABASE_URL
if (!databaseUrl) throw new Error('Node media integration requires isolated PG')
const db = createDb(databaseUrl, { max: 3 })
const sql = db.$client
const secret = randomUUID()
const counts = new Map<string, number>()
const fixtures: { workspaceId: string; taskId: string }[] = []
const workers: ReturnType<typeof startMediaWorker>[] = []
let s3: Awaited<ReturnType<typeof startMediaS3Fixture>>
let directory: string
const result: MediaResult = {
  outputs: [
    {
      url: 'https://fal.media/b-media-fixture.png',
      mime: 'image/png',
      width: 10,
      height: 20,
    },
  ],
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'b-media-recovery-'))
  s3 = await startMediaS3Fixture()
})
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop()
  counts.clear()
})
afterAll(async () => {
  for (const worker of workers) await worker.stop()
  try {
    for (const { workspaceId: ws, taskId } of fixtures) {
      await createNodeStorage(s3.config).delete(`ws/${ws}/ai/${taskId}/0`)
      await sql`delete from notification where workspace_id=${ws}`
      await sql`delete from file where workspace_id=${ws}`
      await sql`delete from ai_task where workspace_id=${ws}`
      await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id=${ws})`
      await sql`delete from credit_ledger where workspace_id=${ws}`
      await sql`delete from credit_hold where workspace_id=${ws}`
      await sql`delete from credit_grant where workspace_id=${ws}`
      await sql`delete from credit_debt where workspace_id=${ws}`
      await sql`delete from member where organization_id=${ws}`
      await sql`delete from session where user_id=${ws}`
      await sql`delete from organization where id=${ws}`
      await sql`delete from "user" where id=${ws}`
    }
  } finally {
    await db.close()
    await s3?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const workspaceId = newId()
  const taskId = newId()
  fixtures.push({ workspaceId, taskId })
  await db
    .insert(user)
    .values({ id: workspaceId, name: 'Media recovery', email: `${workspaceId}@example.test` })
  await db
    .insert(organization)
    .values({ id: workspaceId, name: 'Media recovery', slug: workspaceId, isPersonal: true })
  await db
    .insert(member)
    .values({ id: newId(), organizationId: workspaceId, userId: workspaceId, role: 'owner' })
  await grant(db, { workspaceId, source: 'admin', sourceRef: newId(), amount: 100 })
  const reservation = await hold(db, {
    workspaceId,
    userId: workspaceId,
    amount: 15,
    refType: 'ai_task',
    refId: taskId,
  })
  const value = { workspaceId, taskId, holdId: reservation.id }
  const token = randomUUID()
  await db.insert(session).values({
    id: newId(),
    token,
    userId: workspaceId,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))
  const cookie = `fixture-session=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`
  await db.insert(aiTask).values({
    id: taskId,
    workspaceId,
    userId: workspaceId,
    kind: 'image',
    modelKey: 'recovery-image',
    provider: 'fal',
    providerRequestKey: taskId,
    holdId: reservation.id,
    pricing: { mode: 'per_call', credits: 15 },
    input: {
      params: { num_images: 1 },
      providerModelId: 'fake/image',
      unitsLimit: 1,
      fileParams: [],
      storageBytes: 1000,
    },
    workflowInstanceId: taskId,
    deadlineAt: new Date(Date.now() + 2 * 60 * 60_000),
  })
  return { ...value, cookie }
}

async function worker(executorId: string, crashAfter?: 'persist' | 'settle-and-notify') {
  const value = startMediaWorker(
    {
      executorId,
      storage: s3.config,
      secret,
      ownershipDirectory: directory,
      ...(crashAfter ? { crashAfter } : {}),
    },
    counts,
  )
  workers.push(value)
  const ready = await value.wait('ready')
  return { ...value, origin: `http://127.0.0.1:${ready.port}` }
}
async function http(origin: string, command: Record<string, unknown>) {
  return fetch(`${origin}/internal/workflows/ai-media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000),
  })
}
async function command(origin: string, operation: string, fields: Record<string, unknown>) {
  const response = await http(origin, { operation, ...fields })
  expect(response.status).toBe(200)
  return response.json()
}
async function state(origin: string, id: string) {
  return (await command(origin, 'status', { id })) as { status: string; output?: unknown }
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(50)
  }
  throw new Error('Node media persistent state timed out')
}
async function waitForMedia(origin: string, taskId: string) {
  await eventually(
    () => state(origin, taskId),
    (value) => value.status === 'waiting',
  )
  const [wait] = await db
    .select()
    .from(jobWorkflowWait)
    .where(eq(jobWorkflowWait.workflowId, nativeId(taskId)))
  if (!wait) throw new Error('Node media wait was not persisted')
  expect(wait.deadline.getTime() - wait.createdAt.getTime()).toBeGreaterThan(899_000)
  return wait.deadline
}
function nativeId(id: string) {
  return `workflow:${Buffer.from('ai-media-v1').toString('base64url')}:${Buffer.from(id).toString('base64url')}`
}
function webDeps(origin: string): MediaHttpDeps {
  const provider: MediaProvider = {
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: async () => {
      throw new Error('Web fixture must not submit')
    },
    getStatus: async () => {
      throw new Error('Web fixture must not poll')
    },
    parseWebhook: async () => ({ jobId: 'fixture-job', result }),
    cancel: async () => {},
  }
  return {
    db,
    auth: {
      $context: Promise.resolve({
        secret,
        authCookies: { sessionToken: { name: 'fixture-session' } },
      }),
    },
    env: { MEDIA_WEBHOOK_SECRET: secret },
    workflow: {
      available: true,
      value: createNodeMediaWorkflowClient({ jobsUrl: origin, secret }),
    },
    rateLimiter: { limit: async () => ({ success: true }) },
    providerFactory: () => provider,
  }
}
async function callback(f: Awaited<ReturnType<typeof fixture>>, origin: string) {
  const url = await mediaCallbackUrl('https://app.example.test', secret, {
    id: f.taskId,
    provider: 'fal',
  })
  const response = await handleMediaWebhook(
    new Request(url, { method: 'POST', body: '{}' }),
    'fal',
    webDeps(origin),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
}
async function cancel(f: Awaited<ReturnType<typeof fixture>>, origin: string) {
  return handleMediaCancel(
    new Request(`https://app.example.test/api/ai/tasks/${f.taskId}/cancel`, {
      method: 'POST',
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: f.workspaceId }),
    }),
    f.taskId,
    webDeps(origin),
  )
}
async function wake(origin: string, id: string) {
  return command(origin, 'sendEvent', { id, event: { type: MEDIA_DONE_EVENT, payload: null } })
}
async function business(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await scoped(db, f.workspaceId).findById(aiTask, f.taskId)
  const [reservation] =
    await sql`select status,captured_amount from credit_hold where id=${f.holdId}`
  const ledger =
    await sql`select delta from credit_ledger where workspace_id=${f.workspaceId} and type='consume'`
  const notices = await sql`select type from notification where workspace_id=${f.workspaceId}`
  const files =
    await sql`select id,status,r2_key,size::integer as size from file where source_task_id=${f.taskId}`
  return {
    task,
    hold: reservation,
    ledger,
    notices,
    files,
    balance: await getCreditBalance(db, f.workspaceId),
  }
}

it.each(['persist', 'settle-and-notify'] as const)(
  'recovers the original workflow after offline callback and %s side effect before checkpoint',
  async (crashAfter) => {
    const f = await fixture()
    const executorId = `b-media-${newId()}`
    const first = await worker(executorId)
    expect(
      await command(first.origin, 'create', { id: f.taskId, params: { taskId: f.taskId } }),
    ).toEqual({ id: f.taskId })
    expect(await command(first.origin, 'get', { id: f.taskId })).toEqual({ id: f.taskId })
    const deadline = await waitForMedia(first.origin, f.taskId)
    await first.stop('SIGKILL')
    await callback(f, first.origin)
    // 停机期间通知不可达，先落库的结果保留；恢复后显式补唤醒，不篡改15分钟生产等待。
    await expect(
      http(first.origin, {
        operation: 'sendEvent',
        id: f.taskId,
        event: { type: MEDIA_DONE_EVENT, payload: null },
      }),
    ).rejects.toThrow()
    expect((await business(f)).task.callbackPayload).toMatchObject({ jobId: 'fixture-job', result })
    const second = await worker(executorId, crashAfter)
    await waitForMedia(second.origin, f.taskId)
    const [restored] = await db
      .select()
      .from(jobWorkflowWait)
      .where(eq(jobWorkflowWait.workflowId, nativeId(f.taskId)))
    expect(restored?.deadline).toEqual(deadline)
    await wake(second.origin, f.taskId)
    expect(await second.wait('before-checkpoint')).toMatchObject({ step: crashAfter })
    await second.exited()
    expect(second.child.signalCode).toBe('SIGKILL')
    const before = await business(f)
    expect(before.files).toEqual([expect.objectContaining({ status: 'ready', size: 3 })])
    const third = await worker(executorId)
    expect(
      await eventually(
        () => state(third.origin, f.taskId),
        (value) => value.status === 'completed',
      ),
    ).toMatchObject({ output: { taskId: f.taskId, status: 'succeeded' } })
    expect(await business(f)).toMatchObject({
      task: {
        status: 'succeeded',
        creditsCharged: 15,
        providerJobId: 'fixture-job',
        workflowInstanceId: f.taskId,
      },
      hold: { status: 'captured', captured_amount: 15 },
      ledger: [{ delta: -15 }],
      notices: [{ type: 'ai_task.succeeded' }],
      balance: { available: 85, held: 0 },
      files: [
        {
          id: before.files[0]?.id,
          r2_key: `ws/${f.workspaceId}/ai/${f.taskId}/0`,
          status: 'ready',
          size: 3,
        },
      ],
    })
    expect(await createNodeStorage(s3.config).head(`ws/${f.workspaceId}/ai/${f.taskId}/0`)).toEqual(
      { size: 3, mime: 'image/png' },
    )
    expect(counts.get('submit')).toBe(1)
    expect(counts.get('download')).toBe(1)
  },
)

it('keeps released cancellation through late callback and restart, and exposes formal termination', async () => {
  const f = await fixture()
  const executorId = `b-media-${newId()}`
  const first = await worker(executorId)
  await command(first.origin, 'create', { params: { taskId: f.taskId } })
  await waitForMedia(first.origin, f.taskId)
  await first.stop('SIGKILL')
  const pending = await cancel(f, first.origin)
  expect(pending.status).toBe(202)
  expect(await pending.json()).toMatchObject({ status: 'canceled', cancellationPending: true })
  expect((await business(f)).task.errorCode).toBe('MEDIA_CANCEL_PENDING')
  await callback(f, first.origin)
  const second = await worker(executorId)
  // 终态自检在恢复入口执行，晚回调不能继续转存或扣费。
  expect(
    await eventually(
      () => state(second.origin, f.taskId),
      (value) => value.status === 'completed',
    ),
  ).toMatchObject({ output: { taskId: f.taskId, status: 'canceled' } })
  expect(await business(f)).toMatchObject({
    task: { status: 'canceled', creditsCharged: 0 },
    hold: { status: 'released', captured_amount: 0 },
    ledger: [],
    notices: [],
    files: [],
    balance: { available: 100, held: 0 },
  })
  expect(await createNodeStorage(s3.config).head(`ws/${f.workspaceId}/ai/${f.taskId}/0`)).toBeNull()
  expect(counts.get('submit')).toBe(1)
  expect(counts.get('download') ?? 0).toBe(0)
  expect((await cancel(f, second.origin)).status).toBe(200)
  expect((await business(f)).task.errorCode).toBeNull()
  expect(
    (
      await http(second.origin, {
        operation: 'sendEvent',
        id: f.taskId,
        event: { type: MEDIA_DONE_EVENT, payload: null },
      })
    ).status,
  ).toBe(409)

  const canceled = await fixture()
  await command(second.origin, 'create', { params: { taskId: canceled.taskId } })
  await waitForMedia(second.origin, canceled.taskId)
  expect((await cancel(canceled, second.origin)).status).toBe(200)
  expect(await state(second.origin, canceled.taskId)).toMatchObject({ status: 'terminated' })
  expect((await business(canceled)).hold).toMatchObject({ status: 'released', captured_amount: 0 })
})
