import { env } from 'cloudflare:workers'
import { getCreditBalance, grant, hold } from '@product-res/credits'
import {
  type AiPricingJson,
  aiTask,
  createDb,
  file,
  member,
  organization,
  user,
} from '@product-res/db'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { settleMediaTask } from '../../../packages/ai/src/media/tasks.ts'

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const id = () => crypto.randomUUID()
const workspaces: string[] = []

async function fixture(pricing: AiPricingJson = { mode: 'per_call', credits: 15 }) {
  const ws = id()
  const taskId = id()
  workspaces.push(ws)
  await db
    .insert(user)
    .values({ id: ws, name: 'Media', email: `${ws}@media-settlement.example.test` })
  await db.insert(organization).values({ id: ws, name: 'Media', slug: ws })
  await db.insert(member).values({ id: id(), userId: ws, organizationId: ws, role: 'owner' })
  await grant(db, { workspaceId: ws, source: 'admin', sourceRef: id(), amount: 100 })
  const reservation = await hold(db, {
    workspaceId: ws,
    userId: ws,
    amount: 15,
    refType: 'ai_task',
    refId: taskId,
  })
  await db.insert(aiTask).values({
    id: taskId,
    workspaceId: ws,
    userId: ws,
    kind: 'video',
    modelKey: 'frozen-model',
    pricing,
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
    deadlineAt: new Date(Date.now() + 7200000),
  })
  const fileId = id()
  await db.insert(file).values({
    id: fileId,
    workspaceId: ws,
    userId: ws,
    purpose: 'ai_output',
    status: 'ready',
    sourceTaskId: taskId,
    r2Key: `ws/${ws}/tasks/${taskId}/0`,
    mime: 'video/mp4',
    size: 10,
    publicToken: id(),
  })
  return { workspaceId: ws, taskId, holdId: reservation.id, fileId }
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const [reservation] = await sql<{ status: string; captured_amount: number }[]>`
    select status, captured_amount from credit_hold where id = ${f.holdId}`
  const ledger = await sql<{ delta: number }[]>`
    select delta from credit_ledger where workspace_id = ${f.workspaceId} and type = 'consume'`
  const notices = await sql<{ type: string; link: string }[]>`
    select type, link from notification where workspace_id = ${f.workspaceId}`
  const [output] = await sql<{ deleted: boolean; public_token: string | null }[]>`
    select deleted_at is not null as deleted, public_token from file where id = ${f.fileId}`
  const [invariant] = await sql<{ valid: boolean }[]>`
    select (select coalesce(sum(delta),0) from credit_ledger where workspace_id=${f.workspaceId}) =
      (select coalesce(sum(remaining),0) from credit_grant where workspace_id=${f.workspaceId} and status='active') +
      (select coalesce(sum(amount),0) from credit_hold where workspace_id=${f.workspaceId} and status='held') -
      (select coalesce(sum(amount),0) from credit_debt where workspace_id=${f.workspaceId}) as valid`
  expect(invariant?.valid).toBe(true)
  return {
    hold: reservation,
    ledger,
    notices,
    file: output,
    balance: await getCreditBalance(db, f.workspaceId),
  }
}

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  for (const ws of workspaces) {
    await sql`delete from notification where workspace_id=${ws}`
    await sql`delete from file where workspace_id=${ws}`
    await sql`delete from ai_task where workspace_id=${ws}`
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

it('successful replays capture once, persist output and notify once', async () => {
  const f = await fixture()
  const result = {
    outputs: [{ url: 'https://provider.example.test/video', mime: 'video/mp4' }],
    usage: { seconds: 3 },
  }
  const input = {
    ...f,
    outcome: 'succeeded' as const,
    result,
    files: [{ id: f.fileId, mime: 'video/mp4', size: 10 }],
  }
  const [first, replay] = await Promise.all([
    settleMediaTask(db, input),
    settleMediaTask(db, input),
  ])
  expect(replay).toEqual(first)
  expect(first).toMatchObject({
    status: 'succeeded',
    creditsCharged: 15,
    output: { files: input.files, usage: result.usage, result },
  })
  expect(await state(f)).toMatchObject({
    hold: { status: 'captured', captured_amount: 15 },
    ledger: [{ delta: -15 }],
    notices: [{ type: 'ai_task.succeeded', link: `/app/${f.workspaceId}/tasks/${f.taskId}` }],
    file: { deleted: false },
    balance: { available: 85, held: 0 },
  })
  expect(await settleMediaTask(db, { ...f, outcome: 'canceled' })).toEqual(first)
})

it('per-unit settlement caps excess reported duration at the request limit', async () => {
  const f = await fixture({ mode: 'per_unit', unit: 'second', perUnit: 3 })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const task = await settleMediaTask(db, {
    ...f,
    outcome: 'succeeded',
    result: { outputs: [], usage: { seconds: 6 } },
    files: [],
  })
  expect(task.creditsCharged).toBe(15)
  expect(warning).toHaveBeenCalled()
  expect(await state(f)).toMatchObject({
    hold: { captured_amount: 15 },
    balance: { available: 85, held: 0 },
  })
})

it('failed generation releases its whole hold and revokes partial output access', async () => {
  const f = await fixture()
  const task = await settleMediaTask(db, {
    ...f,
    outcome: 'failed',
    error: { code: 'PROVIDER_FAILED', message: 'Generation failed' },
  })
  expect(task).toMatchObject({ status: 'failed', creditsCharged: 0, errorCode: 'PROVIDER_FAILED' })
  expect(await state(f)).toMatchObject({
    hold: { status: 'released', captured_amount: 0 },
    ledger: [],
    notices: [{ type: 'ai_task.failed' }],
    file: { deleted: true, public_token: null },
    balance: { available: 100, held: 0 },
  })
})

it('queued cancellation refunds everything, remains terminal on a late success and joins caller transactions', async () => {
  const f = await fixture()
  const canceled = await db.transaction((tx) =>
    settleMediaTask(db, { ...f, outcome: 'canceled' }, tx),
  )
  expect(canceled.status).toBe('canceled')
  expect(
    await settleMediaTask(db, { ...f, outcome: 'succeeded', result: { outputs: [] }, files: [] }),
  ).toEqual(canceled)
  expect(await state(f)).toMatchObject({
    hold: { status: 'released', captured_amount: 0 },
    ledger: [],
    notices: [],
    file: { deleted: true, public_token: null },
    balance: { available: 100, held: 0 },
  })
})

it('rolls back the task, ledger and notification together when the caller transaction fails', async () => {
  const f = await fixture()
  await expect(
    db.transaction(async (tx) => {
      await settleMediaTask(
        db,
        {
          ...f,
          outcome: 'succeeded',
          result: { outputs: [] },
          files: [],
        },
        tx,
      )
      throw new Error('Abort caller transaction')
    }),
  ).rejects.toThrow('Abort caller transaction')
  const [task] = await sql<{ status: string }[]>`select status from ai_task where id=${f.taskId}`
  expect(task?.status).toBe('queued')
  expect(await state(f)).toMatchObject({
    hold: { status: 'held', captured_amount: 0 },
    ledger: [],
    notices: [],
    file: { deleted: false },
    balance: { available: 85, held: 15 },
  })
})
