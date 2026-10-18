import { env } from 'cloudflare:workers'
import {
  createFalMediaProvider,
  initialMediaFaultProof,
  MEDIA_HOLD_SWEEP_BUFFER_MS,
  type MediaFaultMode,
  type MediaProvider,
  type MediaWebhook,
  mediaCallbackUrl,
  mediaFaultPolicy,
  readMediaFault,
  settleMediaTask,
  updateMediaFaultProof,
  WORKERS_AI_IMAGE_MODEL,
} from '@product-res/ai'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { getCreditBalance, grant } from '@product-res/credits'
import { aiModel, aiTask, createDb, file, member as membership, scoped } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import {
  createCloudflareRateLimiter,
  createCloudflareWorkflow,
} from '@product-res/platform/cloudflare'
import { AppError, newId } from '@product-res/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  handleMediaCancel,
  handleMediaDetail,
  handleMediaList,
  handleMediaSubmit,
  handleMediaWebhook,
  type MediaHttpDeps,
  submitWorkspaceMedia,
} from '../src/features/ai/media-tasks.ts'
import { templateConfig } from '../src/server/template-config.ts'

const APP_URL = 'http://localhost:3000'
const SECRET = 'fixture-media-webhook-secret'
const EMAIL_DOMAIN = `${newId()}.web-media-test.example`
const MODEL_PREFIX = `media-test-${newId()}-`
const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
  db,
  {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  },
)
const authPost = (path: string, body: unknown) =>
  auth.handler(
    new Request(`${APP_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_URL },
      body: JSON.stringify(body),
    }),
  )
async function account(name: string) {
  const email = `${name}-${newId()}@${EMAIL_DOMAIN}`
  const registered = await authPost('/sign-up/email', {
    email,
    password: 'correct-horse-battery-staple',
    name,
  })
  expect(registered.status).toBe(200)
  const { user } = (await registered.json()) as { user: { id: string } }
  const login = await authPost('/sign-in/email', {
    email,
    password: 'correct-horse-battery-staple',
  })
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  await grant(db, { workspaceId: user.id, source: 'admin', sourceRef: newId(), amount: 100 })
  return { userId: user.id, workspaceId: user.id, cookie }
}
async function model(
  extra: Record<string, unknown> = {},
  provider = 'fal',
  kind: 'image' | 'video' = 'image',
) {
  const key = `${MODEL_PREFIX}${newId()}`
  await db.insert(aiModel).values({
    key,
    kind,
    provider,
    providerModelId: provider === 'workers-ai' ? WORKERS_AI_IMAGE_MODEL : 'fal-ai/fixture',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        num_images: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
        ...extra,
      },
    },
  })
  return key
}
async function faultModel(mode: MediaFaultMode) {
  const key = `acceptance-fault-${MODEL_PREFIX}${newId()}`
  const workers = mode.startsWith('workers-')
  await db.insert(aiModel).values({
    key,
    kind: 'image',
    provider: workers ? 'workers-ai' : 'fal',
    providerModelId: workers ? WORKERS_AI_IMAGE_MODEL : 'fal-ai/flux/schnell',
    pricing: { mode: 'per_call', credits: 3 },
    paramsSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        image_size: { type: 'string', enum: ['square', 'landscape_4_3'] },
        num_images: { type: 'integer', minimum: 1, maximum: 2 },
      },
      'x-acceptance-fault': { mode },
    },
  })
  return key
}
async function administrator(name: string) {
  const who = await account(name)
  // 保留原登录 cookie，敏感入口必须从数据库读取刚更新的平台角色。
  await sql`update "user" set role='admin' where id=${who.userId}`
  return who
}
function faultDependencies() {
  const state = dependencies()
  state.deps.env = {
    ...state.deps.env,
    AI_FAULT_INJECTION: 'enabled',
    SENTRY_ENVIRONMENT: 'staging',
    AI: {
      run: async () => {
        throw new Error('web must not infer')
      },
    },
  }
  return state
}
async function signedFalCallbacks() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const requests: string[] = []
  const provider = createFalMediaProvider({
    apiKey: 'fixture-only',
    modelId: 'fal-ai/flux/schnell',
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      // 仅提供临时公钥，任何队列、图片下载或未知请求都不能访问外部网络。
      if (url !== 'https://rest.fal.ai/.well-known/jwks.json')
        throw new Error('Unexpected fal fixture request')
      return Response.json({ keys: [{ x: publicKey.x }] })
    },
  })
  const hex = (bytes: ArrayBuffer) =>
    Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
  return {
    provider,
    requests,
    async request(taskId: string, jobId: string) {
      const url = await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'fal' })
      const body = JSON.stringify({
        request_id: jobId,
        status: 'OK',
        payload: {
          images: [{ url: 'https://v3.fal.media/fixture.png', content_type: 'image/png' }],
        },
      })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const encoder = new TextEncoder()
      const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
      const signature = await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        encoder.encode([jobId, 'fixture-user', timestamp, hash].join('\n')),
      )
      return new Request(url, {
        method: 'POST',
        body,
        headers: {
          'x-fal-webhook-request-id': jobId,
          'x-fal-webhook-user-id': 'fixture-user',
          'x-fal-webhook-timestamp': timestamp,
          'x-fal-webhook-signature': hex(signature),
        },
      })
    },
  }
}
function dependencies(
  options: {
    max?: number
    startFails?: boolean
    cancelFails?: boolean
    // 取消读到 running 后实例自行结束：CF 绑定的 terminate 对终态实例抛错
    finishesBeforeTerminate?: boolean
    callback?: MediaWebhook
    invalidProviderSignature?: boolean
  } = {},
) {
  let parsed = 0
  let canceled = 0
  let terminated = 0
  let events = 0
  const provider: MediaProvider = {
    id: 'fal',
    capabilities: { idempotentSubmit: false },
    submit: async () => ({ jobId: 'unused' }),
    getStatus: async () => ({ status: 'queued' }),
    parseWebhook: async () => {
      parsed++
      if (options.invalidProviderSignature)
        throw new AppError('MEDIA_WEBHOOK_INVALID', 'Invalid provider signature')
      return (
        options.callback ?? {
          jobId: 'fixture-job',
          result: { outputs: [{ url: 'https://v3.fal.media/output.png', mime: 'image/png' }] },
        }
      )
    },
    cancel: async () => {
      canceled++
      if (options.cancelFails) throw new Error('fixture cancel unavailable')
    },
  }
  const deps: MediaHttpDeps = {
    db,
    auth,
    env: { MEDIA_WEBHOOK_SECRET: SECRET },
    rateLimiter: createCloudflareRateLimiter({ RL_AI: { limit: async () => ({ success: true }) } }),
    providerFactory: () => provider,
    entitlements: async () => ({
      key: 'fixture',
      sort: 0,
      features: { ...DEFAULT_FREE_FEATURES, models: ['*'], maxConcurrentTasks: options.max ?? 3 },
    }),
    workflow: {
      available: true,
      value: createCloudflareWorkflow({
        create: async () => {
          if (options.startFails) throw new Error('fixture start unavailable')
          return {
            id: 'fixture-created',
            status: async () => ({ status: 'running' }),
            terminate: async () => {},
            sendEvent: async () => {},
          }
        },
        get: async (instanceId: string) => {
          let finished = false
          return {
            id: instanceId,
            status: async () => ({
              status: finished ? 'complete' : terminated > 0 ? 'terminated' : 'running',
            }),
            terminate: async () => {
              if (options.finishesBeforeTerminate) {
                finished = true
                throw new Error(
                  'WorkflowError: (instance.cannot_terminate) Cannot terminate instance since its on a finite state',
                )
              }
              terminated++
            },
            sendEvent: async () => {
              events++
              const [stored] =
                await sql`select callback_payload from ai_task where workflow_instance_id=${instanceId}`
              expect(stored?.callback_payload).not.toBeNull()
              throw new Error('fixture delivery unavailable')
            },
          }
        },
      } as unknown as Parameters<typeof createCloudflareWorkflow>[0]),
    },
  }
  return { deps, counts: () => ({ parsed, canceled, terminated, events }) }
}
function post(path: string, who: { cookie: string }, body: unknown) {
  return new Request(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { cookie: who.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function submit(
  who: { workspaceId: string; cookie: string },
  key: string,
  deps: MediaHttpDeps,
  params: Record<string, unknown> = { prompt: 'fixture' },
) {
  return handleMediaSubmit(
    post('/api/ai/tasks', who, { workspaceId: who.workspaceId, modelKey: key, params }),
    deps,
  )
}
async function submitted(
  who: { workspaceId: string; cookie: string },
  key: string,
  deps: MediaHttpDeps,
) {
  const res = await submit(who, key, deps)
  expect(res.status).toBe(202)
  return ((await res.json()) as { taskId: string }).taskId
}

afterAll(async () => {
  const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  await sql`delete from file where workspace_id in (${ids})`
  await sql`delete from notification where workspace_id in (${ids})`
  await sql`delete from ai_task where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where organization_id in (${ids}) or user_id in (${ids})`
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${MODEL_PREFIX}%`}`
  await sql`delete from ai_model where key like ${`acceptance-fault-${MODEL_PREFIX}%`}`
})

// 生成时关闭了图片和视频时，媒体路由不存在
describe.skipIf(!templateConfig.ai.image && !templateConfig.ai.video)('media tasks API', () => {
  it.each(['workers-timeout', 'fal-timeout'] as const)(
    '%s 冻结管理员故障策略和 60 秒 deadline，模型停用与并发证明更新不改变输入',
    async (mode) => {
      const who = await administrator(mode)
      const key = await faultModel(mode)
      const { deps } = faultDependencies()
      const before = Date.now()
      const taskId = await submitted(who, key, deps)
      const acceptedAt = Date.now()
      const tenant = scoped(db, who.workspaceId)
      const task = await tenant.findById(aiTask, taskId)
      const snapshot = mediaFaultPolicy(mode)
      expect(task.input.acceptanceFault).toEqual(snapshot)
      expect(snapshot).toMatchObject({
        policyVersion: 1,
        authorizedAdmin: true,
        deadlineMs: 60_000,
        initialWaitMs: mode === 'fal-timeout' ? 5_000 : 0,
        barrierMs: 0,
      })
      expect(task.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
      expect(task.deadlineAt.getTime()).toBeLessThanOrEqual(acceptedAt + 60_000)
      const [reservation] = await sql<{ expires_at: string }[]>`
        select expires_at from credit_hold where id=${task.holdId}`
      expect(new Date(reservation?.expires_at ?? '').getTime()).toBe(
        task.deadlineAt.getTime() + 10 * 60_000,
      )
      expect(task.input.acceptanceFaultProof).toEqual(initialMediaFaultProof(snapshot))
      if (mode === 'fal-timeout')
        expect(task.input.params).toEqual({
          prompt: 'fixture',
          image_size: 'square',
          num_images: 1,
        })

      const changedMode = mode === 'workers-timeout' ? 'workers-error' : 'fal-provider-error'
      await sql`update ai_model set enabled=false, params_schema=jsonb_set(params_schema,
        '{x-acceptance-fault}', ${JSON.stringify({ mode: changedMode })}::jsonb) where key=${key}`
      expect(readMediaFault(await tenant.findById(aiTask, taskId))).toEqual(snapshot)
      expect((await submit(who, key, deps)).status).toBe(404)
      await Promise.all([
        updateMediaFaultProof(db, task, { submitAttempts: 1, realRequestId: 'fixture-proof-job' }),
        updateMediaFaultProof(db, task, { pollCount: 2, injected: true }),
      ])
      const updated = await tenant.findById(aiTask, taskId)
      expect(updated.input).toEqual({
        ...task.input,
        acceptanceFaultProof: {
          ...initialMediaFaultProof(snapshot),
          submitAttempts: 1,
          realRequestId: 'fixture-proof-job',
          pollCount: 2,
          injected: true,
        },
      })
      expect(updated.deadlineAt).toEqual(task.deadlineAt)
      expect(await tenant.count(aiTask)).toBe(1)
      expect(
        await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
      ).toHaveLength(1)
    },
  )

  it('fal 专用请求拒绝非 square 或多图片且不预扣，合法请求固定为单张 square', async () => {
    const who = await administrator('fault-params')
    const key = await faultModel('fal-callback-lost')
    const { deps } = faultDependencies()
    for (const params of [
      { prompt: 'fixture', image_size: 'landscape_4_3' },
      { prompt: 'fixture', num_images: 2 },
    ]) {
      const response = await submit(who, key, deps, params)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    }
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    const taskId = await submitted(who, key, deps)
    const task = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(task.input.params).toEqual({ prompt: 'fixture', image_size: 'square', num_images: 1 })
    expect(task.input.unitsLimit).toBe(1)
    expect(task.input.acceptanceFault).toEqual(mediaFaultPolicy('fal-callback-lost'))
  })

  it('early 回调经过真实 HMAC 和 fal Ed25519 验签先落库，重放保留首次时间及不可变输入', async () => {
    const who = await administrator('fault-early-callback')
    const state = faultDependencies()
    const signed = await signedFalCallbacks()
    state.deps.providerFactory = () => signed.provider
    const taskId = await submitted(who, await faultModel('fal-callback-early'), state.deps)
    const tenant = scoped(db, who.workspaceId)
    const original = await tenant.findById(aiTask, taskId)
    expect(original.input.acceptanceFault).toEqual({
      mode: 'fal-callback-early',
      policyVersion: 1,
      authorizedAdmin: true,
      deadlineMs: 20 * 60_000,
      initialWaitMs: 5_000,
      barrierMs: 10 * 60_000,
    })
    expect(original.providerJobId).toBeNull()
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-early-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const stored = await tenant.findById(aiTask, taskId)
    const proof = stored.input.acceptanceFaultProof as { callbackStoredAt: string }
    expect(Number.isFinite(Date.parse(proof.callbackStoredAt))).toBe(true)
    expect(stored.input).toEqual({
      ...original.input,
      acceptanceFaultProof: {
        ...(original.input.acceptanceFaultProof as object),
        callbackStoredAt: proof.callbackStoredAt,
      },
    })
    expect(stored.callbackPayload).toMatchObject({
      jobId: 'fixture-early-job',
      result: { outputs: [{ url: 'https://v3.fal.media/fixture.png', mime: 'image/png' }] },
    })
    expect(state.counts().events).toBe(1)
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-early-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const replayed = await tenant.findById(aiTask, taskId)
    expect(replayed.input).toEqual(stored.input)
    expect(replayed.callbackPayload).toEqual(stored.callbackPayload)
    expect(replayed.status).toBe('queued')
    expect(replayed.output).toBeNull()
    expect(signed.requests).toEqual(['https://rest.fal.ai/.well-known/jwks.json'])
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it.each([
    'fal-callback-lost',
    'fal-submit-response-lost',
    'fal-provider-error',
    'fal-timeout',
  ] as const)('%s 只在真实签名校验后忽略成功回调，终态重放不产出或重复结算', async (mode) => {
    const who = await administrator(mode)
    const state = faultDependencies()
    const signed = await signedFalCallbacks()
    state.deps.providerFactory = () => signed.provider
    const taskId = await submitted(who, await faultModel(mode), state.deps)
    const tenant = scoped(db, who.workspaceId)
    const original = await tenant.findById(aiTask, taskId)
    const invalid = await signed.request(taskId, 'fixture-ignored-job')
    invalid.headers.set('x-fal-webhook-signature', '0'.repeat(128))
    expect((await handleMediaWebhook(invalid, 'fal', state.deps)).status).toBe(400)
    expect(
      (
        await handleMediaWebhook(
          await signed.request(taskId, 'fixture-ignored-job'),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    const ignored = await tenant.findById(aiTask, taskId)
    expect(ignored.input).toEqual(original.input)
    expect(ignored.callbackPayload).toBeNull()
    expect(ignored.status).toBe('queued')
    expect(ignored.output).toBeNull()
    expect(state.counts().events).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })

    if (mode !== 'fal-callback-lost') {
      await settleMediaTask(db, {
        workspaceId: who.workspaceId,
        taskId,
        outcome: 'failed',
        error: { code: 'FIXTURE_FAULT', message: 'Fixture failure' },
      })
      const failed = await tenant.findById(aiTask, taskId)
      const ledger =
        await sql`select id, delta, type from credit_ledger where workspace_id=${who.workspaceId}`
      expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0)
      const holds =
        await sql`select id, status, captured_amount from credit_hold where workspace_id=${who.workspaceId}`
      const notifications =
        await sql`select id from notification where workspace_id=${who.workspaceId}`
      expect(notifications).toHaveLength(1)
      expect(holds).toEqual([{ id: failed.holdId, status: 'released', captured_amount: 0 }])
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          (
            await handleMediaWebhook(
              await signed.request(taskId, 'fixture-ignored-job'),
              'fal',
              state.deps,
            )
          ).status,
        ).toBe(200)
      expect(await tenant.findById(aiTask, taskId)).toEqual(failed)
      expect(
        await sql`select id, delta, type from credit_ledger where workspace_id=${who.workspaceId}`,
      ).toEqual(ledger)
      expect(
        await sql`select id, status, captured_amount from credit_hold where workspace_id=${who.workspaceId}`,
      ).toEqual(holds)
      expect(await sql`select id from notification where workspace_id=${who.workspaceId}`).toEqual(
        notifications,
      )
      expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    }
    expect(await tenant.count(file)).toBe(0)
    expect(
      await sql`select id from notification where workspace_id=${who.workspaceId}`,
    ).toHaveLength(mode === 'fal-callback-lost' ? 0 : 1)
    expect(signed.requests).toEqual(['https://rest.fal.ai/.well-known/jwks.json'])
  })

  it('故障媒体对普通空间 owner 和没有 fresh session 的管理员调用均拒绝，且不创建任务或预扣', async () => {
    const who = await account('fault-denied')
    const key = `acceptance-fault-${newId()}`
    await db.insert(aiModel).values({
      key,
      kind: 'image',
      provider: 'fal',
      providerModelId: 'fal-ai/flux/schnell',
      pricing: { mode: 'per_call', credits: 1 },
      paramsSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        'x-acceptance-fault': { mode: 'fal-timeout' },
      },
    })
    try {
      const { deps } = dependencies()
      deps.env.AI_FAULT_INJECTION = 'enabled'
      deps.env.SENTRY_ENVIRONMENT = 'staging'
      expect((await submit(who, key, deps)).status).toBe(404)
      await sql`update member set role='admin' where user_id=${who.userId}`
      expect((await submit(who, key, deps)).status).toBe(404)
      await sql`update "user" set role='admin' where id=${who.userId}`
      const workspace = await db.query.organization.findFirst({
        where: (o, { eq }) => eq(o.id, who.workspaceId),
      })
      const member = await db.query.member.findFirst({
        where: (m, { eq }) => eq(m.userId, who.userId),
      })
      if (!workspace || !member) throw new Error('Missing fixture workspace')
      await expect(
        submitWorkspaceMedia(
          { modelKey: key, params: { prompt: 'fixture' } },
          { workspace, member },
          { ...deps, callbackOrigin: APP_URL },
        ),
      ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
      expect(await sql`select id from credit_hold where workspace_id=${who.workspaceId}`).toEqual(
        [],
      )
      expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    } finally {
      await sql`delete from ai_model where key=${key}`
    }
  })

  it('rejects an unavailable workflow before rate limiting, task creation or credit holds', async () => {
    const who = await account('workflow-unavailable')
    const { deps } = dependencies()
    deps.workflow = { available: false }
    let calls = 0
    deps.rateLimiter = {
      limit: async () => {
        calls++
        return { success: true }
      },
    }
    const response = await submit(who, await model(), deps)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'CAPABILITY_UNAVAILABLE' } })
    expect(calls).toBe(0)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('rejects unknown, disabled and unconfigured providers before task creation or credit hold', async () => {
    const who = await account('provider-unavailable')
    const { deps } = dependencies()
    expect((await submit(who, await model({}, 'unknown'), deps)).status).toBe(404)
    expect((await submit(who, await model({}, 'workers-ai', 'video'), deps)).status).toBe(404)
    const enabled = templateConfig.ai.mediaProviders
    try {
      Object.defineProperty(templateConfig.ai, 'mediaProviders', {
        value: ['fal'],
        configurable: true,
      })
      expect((await submit(who, await model({}, 'workers-ai'), deps)).status).toBe(404)
    } finally {
      Object.defineProperty(templateConfig.ai, 'mediaProviders', {
        value: enabled,
        configurable: true,
      })
    }
    const { providerFactory: _factory, ...realDeps } = deps
    for (const provider of ['fal', 'workers-ai'])
      expect((await submit(who, await model({}, provider), realDeps)).status).toBe(503)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(
      await sql`select id from credit_hold where workspace_id=${who.workspaceId}`,
    ).toHaveLength(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('accepts a configured Workers AI model without callback secret or invoking inference in web', async () => {
    const who = await account('workers-ai')
    const { deps } = dependencies()
    const { providerFactory: _factory, ...realDeps } = deps
    let calls = 0
    realDeps.env = {
      AI: {
        run: async () => {
          calls++
          throw new Error('web must not infer')
        },
      },
    }
    const taskId = await submitted(who, await model({}, 'workers-ai'), realDeps)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).provider).toBe('workers-ai')
    expect(calls).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 97, held: 3 })
  })

  it('returns 404 for unknown and synchronous provider callbacks before signature or database lookup', async () => {
    const { deps } = dependencies()
    deps.env = {}
    for (const provider of ['unknown', 'workers-ai'])
      expect(
        (
          await handleMediaWebhook(
            new Request(`${APP_URL}/api/webhooks/media/${provider}`),
            provider,
            deps,
          )
        ).status,
      ).toBe(404)
  })

  it('serializes genuinely concurrent submissions under the workspace limit with only accepted holds', async () => {
    const who = await account('concurrency')
    const key = await model()
    const { deps } = dependencies({ max: 2 })
    const results = await Promise.all([
      submit(who, key, deps),
      submit(who, key, deps),
      submit(who, key, deps),
    ])
    expect(results.map((res) => res.status).sort()).toEqual([202, 202, 403])
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(2)
    const [task] = await scoped(db, who.workspaceId).select(aiTask)
    expect(task?.input.callbackOrigin).toBe(APP_URL)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 94, held: 6 })
    const reservations = await sql<{ expires_at: string; deadline_at: string }[]>`
      select h.expires_at, t.deadline_at from credit_hold h
      join ai_task t on t.hold_id=h.id
      where h.workspace_id=${who.workspaceId} and h.status='held'`
    expect(reservations).toHaveLength(2)
    for (const reservation of reservations)
      expect(new Date(reservation.expires_at).getTime()).toBe(
        new Date(reservation.deadline_at).getTime() + MEDIA_HOLD_SWEEP_BUFFER_MS,
      )
  })

  it('rejects invalid parameters and pending file references before reserving credits', async () => {
    const who = await account('invalid')
    const key = await model({ source: { type: 'string', format: 'file' } })
    const { deps } = dependencies()
    expect((await submit(who, key, deps, { prompt: 'fixture', num_images: 10 })).status).toBe(400)
    const fileId = newId()
    await scoped(db, who.workspaceId).insert(file, {
      id: fileId,
      userId: who.userId,
      purpose: 'upload',
      status: 'pending',
      r2Key: `ws/${who.workspaceId}/${fileId}`,
      mime: 'image/png',
      size: 100,
    })
    expect((await submit(who, key, deps, { prompt: 'fixture', source: fileId })).status).toBe(400)
    expect(await scoped(db, who.workspaceId).count(aiTask)).toBe(0)
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('releases the reservation when Workflow creation fails', async () => {
    const who = await account('start-failure')
    const { deps } = dependencies({ startFails: true })
    expect((await submit(who, await model(), deps)).status).toBe(503)
    const [task] = await scoped(db, who.workspaceId).select(aiTask)
    expect(task?.status).toBe('failed')
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('persists an early verified callback before sending an event, deduplicates it, and returns 200 on event failure', async () => {
    const who = await account('callback')
    const state = dependencies()
    const taskId = await submitted(who, await model(), state.deps)
    const url = await mediaCallbackUrl(APP_URL, SECRET, { id: taskId, provider: 'fal' })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(200)
    expect(state.counts()).toMatchObject({ parsed: 1, events: 1 })
    const first = await scoped(db, who.workspaceId).findById(aiTask, taskId)
    expect(first.callbackPayload?.jobId).toBe('fixture-job')
    const duplicate = dependencies({
      callback: { jobId: 'fixture-job', error: { code: 'later-error', message: 'later' } },
    })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          duplicate.deps,
        )
      ).status,
    ).toBe(200)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).callbackPayload).toEqual(
      first.callbackPayload,
    )
    const bad = new URL(url)
    bad.searchParams.set('sig', '0'.repeat(64))
    expect((await handleMediaWebhook(new Request(bad), 'fal', state.deps)).status).toBe(400)
    expect(state.counts().parsed).toBe(1)
    const invalidSignature = dependencies({ invalidProviderSignature: true })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          invalidSignature.deps,
        )
      ).status,
    ).toBe(400)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, { providerJobId: 'different-job' })
    expect(
      (
        await handleMediaWebhook(
          new Request(url, { method: 'POST', body: '{}' }),
          'fal',
          state.deps,
        )
      ).status,
    ).toBe(400)
  })

  it('allows only the submitter to cancel, refunds queued tasks once, and keeps query DTOs private', async () => {
    const owner = await account('cancel')
    const other = await account('member')
    await scoped(db, owner.workspaceId).insert(membership, {
      id: newId(),
      userId: other.userId,
      role: 'member',
    })
    const state = dependencies()
    const taskId = await submitted(owner, await model(), state.deps)
    expect(
      (
        await handleMediaCancel(
          post(`/api/ai/tasks/${taskId}/cancel`, other, { workspaceId: owner.workspaceId }),
          taskId,
          state.deps,
        )
      ).status,
    ).toBe(404)
    const detail = await handleMediaDetail(
      new Request(`${APP_URL}/api/ai/tasks/${taskId}?workspaceId=${owner.workspaceId}`, {
        headers: { cookie: other.cookie },
      }),
      taskId,
      state.deps,
    )
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { task: Record<string, unknown> }
    expect(body.task.canCancel).toBe(false)
    for (const hidden of ['providerJobId', 'callbackPayload', 'providerRequestKey', 'holdId'])
      expect(body.task).not.toHaveProperty(hidden)
    for (let repeat = 0; repeat < 2; repeat++)
      expect(
        (
          await handleMediaCancel(
            post(`/api/ai/tasks/${taskId}/cancel`, owner, { workspaceId: owner.workspaceId }),
            taskId,
            state.deps,
          )
        ).status,
      ).toBe(200)
    expect((await scoped(db, owner.workspaceId).findById(aiTask, taskId)).status).toBe('canceled')
    expect(await getCreditBalance(db, owner.workspaceId)).toMatchObject({ available: 100, held: 0 })
    expect(state.counts().terminated).toBe(1)
    const list = await handleMediaList(
      new Request(`${APP_URL}/api/ai/tasks?workspaceId=${owner.workspaceId}`, {
        headers: { cookie: owner.cookie },
      }),
      state.deps,
    )
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1)
  })

  it('persists recoverable cancellation failure after refund and retries external work without repeating settlement', async () => {
    const who = await account('cancel-retry')
    const options = { cancelFails: true }
    const state = dependencies(options)
    const taskId = await submitted(who, await model(), state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      providerJobId: 'fixture-job',
      status: 'running',
    })
    const cancel = () =>
      handleMediaCancel(
        post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
        taskId,
        state.deps,
      )
    expect((await cancel()).status).toBe(202)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBe(
      'MEDIA_CANCEL_PENDING',
    )
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
    options.cancelFails = false
    expect((await cancel()).status).toBe(200)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBeNull()
    expect(state.counts()).toMatchObject({ canceled: 2, terminated: 1 })
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('does not leave a retry marker when the workflow finishes on its own between status and terminate', async () => {
    const who = await account('cancel-race')
    const state = dependencies({ finishesBeforeTerminate: true })
    const taskId = await submitted(who, await model(), state.deps)
    const response = await handleMediaCancel(
      post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
      taskId,
      state.deps,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'canceled', cancellationPending: false })
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBeNull()
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })

  it('retains the cancellation retry marker while an accepted submission has not returned its job ID', async () => {
    const who = await account('cancel-submit')
    const state = dependencies()
    const taskId = await submitted(who, await model(), state.deps)
    await scoped(db, who.workspaceId).updateById(aiTask, taskId, {
      output: { submissionAttempted: true },
    })
    const response = await handleMediaCancel(
      post(`/api/ai/tasks/${taskId}/cancel`, who, { workspaceId: who.workspaceId }),
      taskId,
      state.deps,
    )
    expect(response.status).toBe(202)
    expect((await scoped(db, who.workspaceId).findById(aiTask, taskId)).errorCode).toBe(
      'MEDIA_CANCEL_PENDING',
    )
    expect(await getCreditBalance(db, who.workspaceId)).toMatchObject({ available: 100, held: 0 })
  })
})
