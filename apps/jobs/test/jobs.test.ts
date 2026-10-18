import { createScheduledController, introspectWorkflowInstance } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { aiTask, createDb, organization, readLastCronAt, user } from '@product-res/db'
import { createCloudflareWorkflow } from '@product-res/platform/cloudflare'
import { MEDIA_DONE_EVENT } from '@product-res/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_CRON } from '../src/cron/heartbeat.ts'
import worker from '../src/index.ts'

describe('apps/jobs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('心跳 Cron 把运行时间写入 jobs.lastCronAt', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const before = Date.now()
    const controller = createScheduledController({
      scheduledTime: new Date(),
      cron: HEARTBEAT_CRON,
    })
    await worker.scheduled(controller, env)

    const lastCronAt = await readLastCronAt(createDb(env.HYPERDRIVE))
    expect(lastCronAt).not.toBeNull()
    expect(Date.parse(lastCronAt ?? '')).toBeGreaterThanOrEqual(before - 1_000)
    expect(log.mock.calls.flat().join(' ')).toContain('cron.heartbeat')
  })

  it('未知的 Cron 表达式报错', async () => {
    const controller = createScheduledController({ cron: '0 0 * * *' })
    await expect(worker.scheduled(controller, env)).rejects.toThrow('Unknown cron')
  })

  it('Cloudflare 入口传递调度 profile 并拒绝未知值', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = createScheduledController({ cron: HEARTBEAT_CRON })
    await expect(worker.scheduled(controller, { ...env, CRON_PROFILE: 'unknown' })).rejects.toThrow(
      'Unknown cron profile',
    )
    expect(error.mock.calls.flat().join(' ')).toContain('cron.unknown_profile')
  })

  it('缺少必需绑定时拒绝处理事件，错误只含变量名', async () => {
    const controller = createScheduledController({ cron: HEARTBEAT_CRON })
    const broken = { ...env, HYPERDRIVE: undefined } as unknown as Cloudflare.Env
    const error = await worker.scheduled(controller, broken).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Invalid environment: missing HYPERDRIVE')
  })

  // 生成时关闭了图片和视频，没有 AI_MEDIA_WORKFLOW 绑定
  it.skipIf(!env.AI_MEDIA_WORKFLOW)(
    'AiMediaWorkflow 跨绑定等待媒体事件，并读取落库回调进入转存与结算步骤',
    async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const id = crypto.randomUUID()
      const instance = await introspectWorkflowInstance(env.AI_MEDIA_WORKFLOW, id)
      const db = createDb(env.HYPERDRIVE)
      await db
        .insert(user)
        .values({ id, name: 'Workflow', email: `${id}@workflow-smoke.example.test` })
      await db.insert(organization).values({ id, name: 'Workflow', slug: id })
      await db.insert(aiTask).values({
        id,
        workspaceId: id,
        userId: id,
        kind: 'image',
        modelKey: 'fixture',
        provider: 'fal',
        providerRequestKey: id,
        input: {
          params: {},
          providerModelId: 'fal-ai/fixture',
          unitsLimit: 1,
          fileParams: [],
          storageBytes: 1000,
        },
        pricing: { mode: 'per_call', credits: 1 },
        deadlineAt: new Date(Date.now() + 7200000),
      })
      const result = {
        outputs: [{ url: 'https://v3.fal.media/files/fixture.png', mime: 'image/png' }],
      }
      try {
        await instance.modify(async (m) => {
          await m.mockStepResult(
            { name: 'submit' },
            { jobId: 'fixture-job', sync: null, stopped: false },
          )
          await m.mockEvent({ type: MEDIA_DONE_EVENT, payload: { taskId: id } })
          await m.mockStepResult({ name: 'recheck-callback' }, { jobId: 'fixture-job', result })
          await m.mockStepResult({ name: 'persist' }, [{ id, mime: 'image/png', size: 8 }])
          await m.mockStepResult({ name: 'settle-and-notify' }, 'succeeded')
        })

        await env.AI_MEDIA_WORKFLOW.create({ id, params: { taskId: id } })

        expect(await instance.waitForStepResult({ name: 'submit' })).toEqual({
          jobId: 'fixture-job',
          sync: null,
          stopped: false,
        })
        await instance.waitForStatus('complete')
        expect(await instance.getOutput()).toEqual({
          taskId: id,
          status: 'succeeded',
        })
      } finally {
        await instance.dispose()
        await db.$client`delete from ai_task where id=${id}`
        await db.$client`delete from organization where id=${id}`
        await db.$client`delete from "user" where id=${id}`
      }
    },
  )

  // 生成时关闭了图片和视频，没有 AI_MEDIA_WORKFLOW 绑定
  it.skipIf(!env.AI_MEDIA_WORKFLOW)(
    '取消读到 running 后实例已自行结束：真实绑定 terminate 抛错，中立适配视为已终止',
    async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const id = crypto.randomUUID()
      const instance = await introspectWorkflowInstance(env.AI_MEDIA_WORKFLOW, id)
      const db = createDb(env.HYPERDRIVE)
      await db
        .insert(user)
        .values({ id, name: 'Cancel', email: `${id}@workflow-cancel.example.test` })
      await db.insert(organization).values({ id, name: 'Cancel', slug: id })
      // 与 staging 一致：HTTP 取消先落库，Workflow 的 submit 自检到终态后正常结束
      await db.insert(aiTask).values({
        id,
        workspaceId: id,
        userId: id,
        kind: 'video',
        modelKey: 'fixture',
        provider: 'fal',
        providerRequestKey: id,
        status: 'canceled',
        input: {
          params: {},
          providerModelId: 'fal-ai/fixture',
          unitsLimit: 1,
          fileParams: [],
          storageBytes: 1000,
        },
        pricing: { mode: 'per_call', credits: 1 },
        deadlineAt: new Date(Date.now() + 7200000),
      })
      try {
        await instance.modify(async (m) => {
          await m.mockStepResult({ name: 'submit' }, { jobId: '', sync: null, stopped: true })
        })
        await env.AI_MEDIA_WORKFLOW.create({ id, params: { taskId: id } })
        const handle = await createCloudflareWorkflow(env.AI_MEDIA_WORKFLOW).get(id)
        await instance.waitForStatus('complete')
        const raw = await env.AI_MEDIA_WORKFLOW.get(id)
        await expect(raw.terminate()).rejects.toThrow('instance.cannot_terminate')
        await expect(handle.terminate()).resolves.toBeUndefined()
        expect((await handle.status()).status).toBe('completed')
      } finally {
        await instance.dispose()
        await db.$client`delete from ai_task where id=${id}`
        await db.$client`delete from organization where id=${id}`
        await db.$client`delete from "user" where id=${id}`
      }
    },
  )
})

it('heartbeat retries committed deletion invalidation using the shared CACHE binding', async () => {
  const db = createDb(env.HYPERDRIVE)
  const id = crypto.randomUUID()
  const key = `revoked-${id}`
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await env.CACHE.put(`auth:${key}`, 'stale-session')
  await db.$client`insert into verification (id,identifier,value,expires_at,created_at,updated_at)
    values (${id},${`deletion-cleanup:${id}`},${JSON.stringify([key])},now()+interval '1 hour',now(),now())`
  try {
    await worker.scheduled(createScheduledController({ cron: HEARTBEAT_CRON }), env)
    expect(await env.CACHE.get(`auth:${key}`)).toBeNull()
    expect(
      await db.query.verification.findFirst({ where: (v, { eq }) => eq(v.id, id) }),
    ).toBeUndefined()
  } finally {
    await env.CACHE.delete(`auth:${key}`)
    await db.$client`delete from verification where id=${id}`
  }
})
