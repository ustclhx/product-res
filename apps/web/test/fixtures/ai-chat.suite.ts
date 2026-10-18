import {
  chatHoldSweeper,
  type LanguageModelFactory,
  settleInterruptedChatMessage,
} from '@product-res/ai'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig, type TemplateConfig } from '@product-res/config'
import { getCreditBalance, grant, hold, reconcileWorkspaceCredits } from '@product-res/credits'
import {
  type AiPricingJson,
  type AiUsageCheckpoint,
  aiConversation,
  aiMessage,
  aiModel,
  creditHold,
  type Database,
  member as memberTable,
  scoped,
} from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import type { BackgroundTasks, RateLimiter } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type ChatDeps,
  type ChatStopDeps,
  handleChatRequest,
  handleChatStopRequest,
  startWorkspaceChat,
} from '../../src/features/ai/chat.ts'

// tasks.md 2.3：POST /api/ai/chat 的三种结算（正常完成、实际少于预扣、实际多于预扣），
// 以及未配置模型工厂时的 503、余额不足与他人对话的拒绝。模型为 AI SDK 的模拟模型。
// tasks.md 2.4、2.5：停止接口（同 isolate / 跨 isolate）、出错结算与用量检查点。

export function registerAiChatSuite(
  db: Database,
  runtime: {
    rateLimiter: RateLimiter
    background: () => BackgroundTasks & { settled: () => Promise<unknown> }
    modelProvider?: string
    mockFactory?: (mock: MockLanguageModelV4) => LanguageModelFactory
  },
) {
  const APP_URL = 'http://localhost:3000'
  const PASSWORD = 'correct-horse-battery-staple'
  const EMAIL_DOMAIN = `${newId()}.web-ai-chat-test.example`
  const OVERAGE = { maxRatio: 0.2, maxCredits: 50, dailyBudgetPerWorkspace: 200 }
  /** 本次运行创建的模型 key 前缀，清理时按它删除 */
  const MODEL_KEY_PREFIX = `chat-test-${newId()}-`
  const FAULT_KEY_PREFIX = `acceptance-fault-${MODEL_KEY_PREFIX}`

  const sql = db.$client
  const auth = createAuth(
    { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
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

  /** 注册并登录；注册会创建个人空间（id 与用户 id 相同） */
  async function member(name: string, credits = 0) {
    const email = `${name}-${newId()}@${EMAIL_DOMAIN}`
    const signUp = await authPost('/sign-up/email', { email, password: PASSWORD, name })
    expect(signUp.status).toBe(200)
    const { user } = (await signUp.json()) as { user: { id: string } }
    const res = await authPost('/sign-in/email', { email, password: PASSWORD })
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .join('; ')
    const [ws] = await sql<{ id: string; slug: string }[]>`
    select id, slug from organization where id = ${user.id}`
    if (!ws) throw new Error('personal workspace missing')
    if (credits > 0)
      await grant(db, { workspaceId: ws.id, source: 'admin', sourceRef: newId(), amount: credits })
    return { userId: user.id, workspaceId: ws.id, slug: ws.slug, cookie }
  }

  async function textModel(pricing: AiPricingJson, maxOutputTokens?: number) {
    const id = newId()
    await db.insert(aiModel).values({
      id,
      key: `${MODEL_KEY_PREFIX}${id}`,
      kind: 'text',
      provider: runtime.modelProvider ?? 'mock',
      providerModelId: 'mock-model',
      pricing,
      paramsSchema: maxOutputTokens ? { 'x-text': { maxOutputTokens } } : null,
    })
    return id
  }

  /** 按块输出 `text`，结束时回报 usage（服务商通常只在流结束时返回 usage） */
  function mockModel(
    text: string,
    usage: { input: number | undefined; output: number | undefined },
  ) {
    const chunks = text.match(/.{1,8}/gs) ?? []
    return new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 't1' },
            ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: {
                inputTokens: {
                  total: usage.input,
                  noCache: usage.input,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    })
  }

  function chatDeps(options: {
    factory?: LanguageModelFactory
    mock?: MockLanguageModelV4
    rateLimiter?: RateLimiter
    env?: ChatDeps['env']
    textConfig?: TemplateConfig['ai']['text']
  }) {
    const background = runtime.background()
    const deps: ChatDeps = {
      db,
      auth,
      env: options.env ?? {},
      rateLimiter: options.rateLimiter ?? runtime.rateLimiter,
      waitUntil: (promise) => background.waitUntil(promise),
      entitlements: async () => ({
        key: 'test',
        sort: 0,
        features: { ...DEFAULT_FREE_FEATURES, models: ['*'] },
      }),
      overage: OVERAGE,
      retryDelay: async () => {},
      ...(options.textConfig ? { textConfig: options.textConfig } : {}),
      ...(options.mock
        ? {
            languageModelFactory:
              runtime.mockFactory?.(options.mock) ?? (() => options.mock as MockLanguageModelV4),
          }
        : options.factory
          ? { languageModelFactory: options.factory }
          : {}),
    }
    return { deps, background }
  }

  /** 发起请求但不读取响应，用于在流式过程中观察检查点或调用停止接口 */
  async function begin(
    who: { slug: string; cookie: string },
    body: { modelId: string; text: string; conversationId?: string; thinking?: boolean },
    options: {
      factory?: LanguageModelFactory
      mock?: MockLanguageModelV4
      rateLimiter?: RateLimiter
      env?: ChatDeps['env']
      textConfig?: TemplateConfig['ai']['text']
    } = {},
  ) {
    const { deps, background } = chatDeps(options)
    const response = await handleChatRequest(
      new Request(`${APP_URL}/api/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: who.cookie },
        body: JSON.stringify({
          slug: who.slug,
          modelId: body.modelId,
          ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
          ...(body.conversationId ? { conversationId: body.conversationId } : {}),
          message: { role: 'user', parts: [{ type: 'text', text: body.text }] },
        }),
      }),
      deps,
    )
    return { response, settled: () => background.settled() }
  }

  /** 模拟模型以流错误结束（中止、服务商断开）时，响应流随之出错；只取已收到的部分 */
  async function bodyText(response: Response) {
    if (!response.body) return ''
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let text = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return text
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      return text
    }
  }

  async function send(
    who: { slug: string; cookie: string },
    body: { modelId: string; text: string; conversationId?: string; thinking?: boolean },
    options: {
      factory?: LanguageModelFactory
      mock?: MockLanguageModelV4
      rateLimiter?: RateLimiter
      env?: ChatDeps['env']
      textConfig?: TemplateConfig['ai']['text']
    } = {},
  ) {
    const { response, settled } = await begin(who, body, options)
    const stream = await bodyText(response)
    await settled()
    return { response, stream }
  }

  /** UI message 流中各 text-delta 拼接出的回复 */
  function streamedText(stream: string) {
    return stream
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; delta?: string })
      .flatMap((chunk) => (chunk.type === 'text-delta' && chunk.delta ? [chunk.delta] : []))
      .join('')
  }

  async function assistantMessage(conversationId: string) {
    const [row] = await sql<
      {
        id: string
        status: string
        parts: { type: string; text: string }[]
        credits: number
        input_tokens: number
        output_tokens: number
        pricing: AiPricingJson
        hold_id: string
        usage_checkpoint: AiUsageCheckpoint | null
      }[]
    >`select * from ai_message where conversation_id = ${conversationId} and role = 'assistant'
    order by id desc limit 1`
    if (!row) throw new Error('assistant message missing')
    const [reservation] = await sql<
      {
        status: string
        amount: number
        captured_amount: number
        overage_absorbed: number
        overage_debited: number
        overage_debt: number
        expires_at: Date | null
      }[]
    >`select * from credit_hold where id = ${row.hold_id}`
    return { message: row, hold: reservation }
  }

  afterAll(async () => {
    const ids = sql`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
    await sql`delete from ai_message where workspace_id in (${ids})`
    await sql`delete from ai_conversation where workspace_id in (${ids})`
    await sql`delete from credit_hold_allocation where hold_id in
    (select id from credit_hold where workspace_id in (${ids}))`
    await sql`delete from credit_ledger where workspace_id in (${ids})`
    await sql`delete from credit_hold where workspace_id in (${ids})`
    await sql`delete from credit_grant where workspace_id in (${ids})`
    await sql`delete from credit_debt where workspace_id in (${ids})`
    await sql`delete from session where user_id in (${ids})`
    await sql`delete from account where user_id in (${ids})`
    await sql`delete from member where user_id in (${ids})`
    await sql`delete from organization where id in (${ids})`
    await sql`delete from "user" where id in (${ids})`
    await sql`delete from ai_model where key like ${`${MODEL_KEY_PREFIX}%`}
      or key like ${`${FAULT_KEY_PREFIX}%`}`
  })

  describe('POST /api/ai/chat 结算', () => {
    it('正常完成（按次）：流式返回完整回复，扣除固定积分，消息标记 completed', async () => {
      const me = await member('per-call', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const mock = mockModel('Hello from the mock model!', { input: 20, output: 7 })
      const { response, stream } = await send(me, { modelId, text: '你好' }, { mock })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const conversationId = response.headers.get('x-conversation-id') as string
      expect(streamedText(stream)).toBe('Hello from the mock model!')
      expect(stream).toContain(conversationId)
      expect(mock.doStreamCalls[0]?.maxOutputTokens).toBe(500)

      const { message, hold } = await assistantMessage(conversationId)
      expect(message).toMatchObject({
        status: 'completed',
        parts: [{ type: 'text', text: 'Hello from the mock model!' }],
        credits: 3,
        input_tokens: 20,
        output_tokens: 7,
        pricing: { mode: 'per_call', credits: 3 },
      })
      expect(hold).toMatchObject({ status: 'captured', amount: 3, captured_amount: 3 })
      expect((await getCreditBalance(db, me.workspaceId)).available).toBe(97)
      const ledger = await sql<{ type: string; delta: number; ref_id: string }[]>`
      select type, delta, ref_id from credit_ledger
      where workspace_id = ${me.workspaceId} and type = 'consume'`
      expect(ledger).toEqual([{ type: 'consume', delta: -3, ref_id: message.id }])
    })

    it('响应逐块转出：模型仍在生成时客户端已收到首段正文（#152）', async () => {
      const me = await member('incremental', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 1,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const usage = {
        inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      }
      const mock = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'text-start', id: 't1' })
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'first' })
              // 放行前模型不会结束：服务端若缓冲整段，下面的读取会一直等待。
              await gate
              controller.enqueue({ type: 'text-delta', id: 't1', delta: ' second' })
              controller.enqueue({ type: 'text-end', id: 't1' })
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage,
              })
              controller.close()
            },
          }),
        }),
      })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock })
      const reader = response.body?.getReader()
      if (!reader) throw new Error('missing response body')
      const decoder = new TextDecoder()
      let early = ''
      while (!streamedText(early).includes('first')) {
        const { done, value } = await reader.read()
        if (done) throw new Error(`stream ended before release: ${response.status}`)
        early += decoder.decode(value, { stream: true })
      }
      expect(streamedText(early)).toBe('first')
      release()
      let rest = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        rest += decoder.decode(value, { stream: true })
      }
      await settled()
      expect(streamedText(early + rest)).toBe('first second')
    })

    it('实际少于预扣（按 token）：预扣 50、实际 12 → 扣除 12、退回 38', async () => {
      const me = await member('token-less', 1000)
      // 预扣 = ceil((估算输入 × 1 + 4900 × 10) / 1000) = 50
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 4900)
      // 实际 = (200 × 1 + 1180 × 10) / 1000 = 12
      const mock = mockModel('short answer', { input: 200, output: 1180 })
      const { response } = await send(me, { modelId, text: 'hi' }, { mock })
      expect(response.status).toBe(200)

      const { message, hold } = await assistantMessage(
        response.headers.get('x-conversation-id') as string,
      )
      expect(hold).toMatchObject({ status: 'captured', amount: 50, captured_amount: 12 })
      expect(message).toMatchObject({ status: 'completed', credits: 12 })
      expect(mock.doStreamCalls[0]?.maxOutputTokens).toBe(4900)
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({
        available: 988,
        held: 0,
        debt: 0,
      })
    })

    it('实际多于预扣（按 token）：回复完整，超出部分按超额规则平台承担 + 从余额补扣', async () => {
      const me = await member('token-more', 1000)
      // 预扣 = ceil((估算输入 × 10 + 1000 × 10) / 1000) = 11
      const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 10 }, 1000)
      // 输入估算偏低：实际 = (400 × 10 + 1000 × 10) / 1000 = 14，超出 3
      const reply = 'A complete reply that must not be truncated.'
      const mock = mockModel(reply, { input: 400, output: 1000 })
      const { response, stream } = await send(me, { modelId, text: 'hi' }, { mock })
      expect(response.status).toBe(200)
      expect(streamedText(stream)).toBe(reply)

      const { message, hold } = await assistantMessage(
        response.headers.get('x-conversation-id') as string,
      )
      // 平台最多承担 floor(11 × 20%) = 2，其余 1 从余额补扣
      expect(hold).toMatchObject({
        status: 'captured',
        amount: 11,
        captured_amount: 11,
        overage_absorbed: 2,
      })
      expect(message).toMatchObject({
        status: 'completed',
        parts: [{ type: 'text', text: reply }],
        credits: 12,
      })
      expect((await getCreditBalance(db, me.workspaceId)).available).toBe(988)
      await assertInvariant(me.workspaceId)
    })
  })

  describe('POST /api/ai/chat 调用前检查', () => {
    it('故障模型仅允许实时平台管理员；普通空间 owner 与管理员 API 上下文均无副作用', async () => {
      const me = await member('fault-denied', 100)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 2 })
      const key = `acceptance-fault-${modelId}`
      await db
        .update(aiModel)
        .set({
          key,
          provider: 'deepseek',
          providerModelId: 'deepseek-flash',
          paramsSchema: { 'x-acceptance-fault': { mode: 'chat-before-stream' } },
        })
        .where(eq(aiModel.id, modelId))
      try {
        const { deps } = chatDeps({
          factory: () => {
            throw new Error('must not invoke provider')
          },
        })
        deps.env.AI_FAULT_INJECTION = 'enabled'
        deps.env.SENTRY_ENVIRONMENT = 'staging'
        const response = await handleChatRequest(
          new Request(`${APP_URL}/api/ai/chat`, {
            method: 'POST',
            headers: { cookie: me.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              slug: me.slug,
              modelId,
              message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            }),
          }),
          deps,
        )
        expect(response.status).toBe(404)
        await sql`update "user" set role='admin' where id=${me.userId}`
        // 管理员的模拟会话也不能触发故障；会话事实直接来自数据库。
        await sql`update session set impersonated_by=${me.userId} where user_id=${me.userId}`
        const impersonated = await handleChatRequest(
          new Request(`${APP_URL}/api/ai/chat`, {
            method: 'POST',
            headers: { cookie: me.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              slug: me.slug,
              modelId,
              message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            }),
          }),
          deps,
        )
        expect(impersonated.status).toBe(404)
        await sql`update session set impersonated_by=null where user_id=${me.userId}`
        // 模拟已鉴权 API key 调用；平台角色也不授予没有 fresh session 的入口权限。
        await sql`update "user" set role='admin' where id=${me.userId}`
        await expect(
          startWorkspaceChat(
            {
              slug: me.slug,
              modelId,
              message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            },
            { workspaceId: me.workspaceId, userId: me.userId },
            deps,
          ),
        ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
        expect(await scoped(db, me.workspaceId).count(aiConversation)).toBe(0)
        expect(await scoped(db, me.workspaceId).count(aiMessage)).toBe(0)
        expect(await sql`select id from credit_hold where workspace_id=${me.workspaceId}`).toEqual(
          [],
        )
        expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({
          available: 100,
          held: 0,
        })
      } finally {
        await db.delete(aiModel).where(eq(aiModel.id, modelId))
      }
    })

    it('Workers AI 能力缺失时在模型工厂与预扣前拒绝，无消息或账本副作用', async () => {
      const me = await member('workers-ai-unavailable', 100)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 1 })
      await db.update(aiModel).set({ provider: 'workers-ai' }).where(eq(aiModel.id, modelId))
      let factoryCalls = 0
      const { response } = await begin(
        me,
        { modelId, text: 'hi' },
        {
          factory: () => {
            factoryCalls++
            return mockModel('never', { input: 1, output: 1 })
          },
        },
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'MODEL_UNAVAILABLE' } })
      expect(factoryCalls).toBe(0)
      expect(await scoped(db, me.workspaceId).count(aiConversation)).toBe(0)
      expect(await scoped(db, me.workspaceId).count(aiMessage)).toBe(0)
      expect(await sql`select id from credit_hold where workspace_id=${me.workspaceId}`).toEqual([])
      expect(await consumeLedger(me.workspaceId)).toEqual([])
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({
        available: 100,
        held: 0,
        debt: 0,
      })
    })

    it('AI policy keeps workspace/user key and rejects before creating messages or holds', async () => {
      const me = await member('rate-rejected', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const mock = mockModel('never', { input: 1, output: 1 })
      const calls: unknown[] = []
      const { response, stream } = await send(
        me,
        { modelId, text: 'hi' },
        {
          mock,
          rateLimiter: {
            limit: async (policy, key) => {
              calls.push([policy, key])
              return { success: false }
            },
          },
        },
      )
      expect(calls).toEqual([['ai', `ai:${me.workspaceId}:${me.userId}`]])
      expect(response.status).toBe(429)
      expect(JSON.parse(stream)).toMatchObject({ error: { code: 'RATE_LIMITED' } })
      expect(mock.doStreamCalls).toHaveLength(0)
      expect(await scoped(db, me.workspaceId).count(aiConversation)).toBe(0)
      expect(
        await sql`select id from credit_hold where workspace_id=${me.workspaceId}`,
      ).toHaveLength(0)
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
    })

    it('未配置模型工厂时返回 503 AI_PROVIDER_NOT_CONFIGURED，不预扣', async () => {
      const me = await member('no-provider', 100)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 1 })
      const { response, stream } = await send(me, { modelId, text: 'hi' })
      expect(response.status).toBe(503)
      expect(JSON.parse(stream)).toMatchObject({ error: { code: 'AI_PROVIDER_NOT_CONFIGURED' } })
      const holds = await sql`select 1 from credit_hold where workspace_id = ${me.workspaceId}`
      expect(holds).toHaveLength(0)
    })

    it('余额不足以支付最小输出时返回 402 INSUFFICIENT_CREDITS，模型未被调用', async () => {
      // 每 token 1 积分：余额 1 连估算的输入都不够，更谈不上最小输出
      const me = await member('poor', 1)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1000, outputPer1k: 1000 })
      const mock = mockModel('never', { input: 1, output: 1 })
      const { response, stream } = await send(me, { modelId, text: 'hi' }, { mock })
      expect(response.status).toBe(402)
      expect(JSON.parse(stream)).toEqual({
        error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits' },
      })
      expect(mock.doStreamCalls).toHaveLength(0)
    })

    it('对话只对创建者可见：同一空间的其他成员带对话 ID 请求返回 404', async () => {
      const owner = await member('owner', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 1,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const first = await send(
        owner,
        { modelId, text: 'first' },
        { mock: mockModel('one', { input: 5, output: 1 }) },
      )
      const conversationId = first.response.headers.get('x-conversation-id') as string

      // 同一对话继续发送：历史随请求发给模型
      const mock = mockModel('two', { input: 9, output: 1 })
      const second = await send(owner, { modelId, text: 'second', conversationId }, { mock })
      expect(second.response.status).toBe(200)
      expect(JSON.stringify(mock.doStreamCalls[0]?.prompt)).toContain('first')

      const other = await member('other')
      await db.insert(memberTable).values({
        id: newId(),
        organizationId: owner.workspaceId,
        userId: other.userId,
        role: 'admin',
      })
      const denied = await send(
        { slug: owner.slug, cookie: other.cookie },
        { modelId, text: 'peek', conversationId },
        { mock: mockModel('x', { input: 1, output: 1 }) },
      )
      expect(denied.response.status).toBe(404)
    })
  })

  const USAGE_FINISH = (input: number, output: number) => ({
    type: 'finish' as const,
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: output, text: output, reasoning: undefined },
    },
  })

  /**
   * 长流模拟：每块 8 个字符（估算 8 个输出 token），在 `gates` 指定的块之前暂停，直到测试放行；
   * 中止时像服务商断开连接一样以错误结束。`reached(i)` 在流停在第 i 块的闸门前时完成。
   */
  function gatedModel(options: {
    chunks: number
    gates: number[]
    usage?: { input: number; output: number }
    /** 在第 n 块之后以服务商错误结束 */
    failAfter?: number
  }) {
    const gates = new Map(
      options.gates.map((index) => {
        let open!: () => void
        let reached!: () => void
        const opened = new Promise<void>((resolve) => {
          open = resolve
        })
        const arrived = new Promise<void>((resolve) => {
          reached = resolve
        })
        return [index, { open, opened, reached, arrived }] as const
      }),
    )
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          async start(controller) {
            const aborted = new Promise<void>((resolve) =>
              abortSignal?.addEventListener('abort', () => resolve()),
            )
            controller.enqueue({ type: 'text-start', id: 't1' })
            for (let i = 0; i < options.chunks; i++) {
              const gate = gates.get(i)
              if (gate) {
                gate.reached()
                await Promise.race([gate.opened, aborted])
              }
              await new Promise((resolve) => setTimeout(resolve, 1))
              if (abortSignal?.aborted) return controller.error(abortSignal.reason)
              if (options.failAfter === i) return controller.error(new Error('provider down'))
              controller.enqueue({ type: 'text-delta', id: 't1', delta: 'abcdefgh' })
            }
            controller.enqueue({ type: 'text-end', id: 't1' })
            const usage = options.usage ?? { input: 1, output: options.chunks * 8 }
            controller.enqueue(USAGE_FINISH(usage.input, usage.output))
            controller.close()
          },
        }),
      }),
    })
    return {
      model,
      reached: (index: number) => gates.get(index)?.arrived as Promise<void>,
      open: (index: number) => gates.get(index)?.open(),
    }
  }

  /** 轮询直到条件成立 */
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await read()
      if (ok(value)) return value
      if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  async function stop(
    who: { slug: string; cookie: string },
    messageId: string,
    deps: Partial<ChatStopDeps> = {},
  ) {
    const response = await handleChatStopRequest(
      new Request(`${APP_URL}/api/ai/chat/${messageId}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: who.cookie },
        body: JSON.stringify({ slug: who.slug }),
      }),
      messageId,
      { db, auth, overage: OVERAGE, ...deps },
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  async function consumeLedger(workspaceId: string) {
    return sql<{ delta: number }[]>`
    select delta from credit_ledger where workspace_id = ${workspaceId} and type = 'consume'`
  }

  async function assertInvariant(workspaceId: string) {
    const [ledger] = await sql<{ total: number }[]>`
    select coalesce(sum(delta), 0)::int as total from credit_ledger
    where workspace_id = ${workspaceId}`
    const balance = await getCreditBalance(db, workspaceId)
    expect(ledger?.total).toBe(balance.available + balance.held - balance.debt)
  }

  /** 封顶后只消费预扣，不额外吸收、补扣或产生欠费，余额与账本仍一致。 */
  async function assertCapped(workspaceId: string, conversationId: string, amount: number) {
    const result = await assistantMessage(conversationId)
    expect(result.message.credits).toBe(amount)
    expect(result.hold).toMatchObject({
      status: 'captured',
      amount,
      captured_amount: amount,
      overage_absorbed: 0,
      overage_debited: 0,
      overage_debt: 0,
    })
    expect(await getCreditBalance(db, workspaceId)).toMatchObject({
      available: 100 - amount,
      held: 0,
      debt: 0,
    })
    expect(await consumeLedger(workspaceId)).toEqual([{ delta: -amount }])
    await assertInvariant(workspaceId)
    return result
  }

  describe('估算结算封顶（tasks 2.8）', () => {
    it('失败时显式提供真实 usage：费用仍以预扣封顶', async () => {
      const me = await member('interrupted-actual', 100)
      const pricing = { mode: 'token' as const, inputPer1k: 10, outputPer1k: 10 }
      const modelId = await textModel(pricing, 1000)
      const gated = gatedModel({ chunks: 10, gates: [0] })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      const conversationId = response.headers.get('x-conversation-id') as string
      await gated.reached(0)
      const { message } = await assistantMessage(conversationId)
      const settlement = await settleInterruptedChatMessage(db, {
        workspaceId: me.workspaceId,
        messageId: message.id,
        holdId: message.hold_id,
        pricing,
        overage: OVERAGE,
        usageSource: 'actual',
        status: 'failed',
        inputTokens: 400,
        outputTokens: 1000,
        hasOutput: true,
      })
      // 真实金额 14、预扣 11：failed 仍封顶 11，原流结束不能改写先结算者的状态。
      expect(settlement).toEqual({ captured: 11, absorbed: 0, debited: 0, debt: 0 })
      gated.open(0)
      await bodyText(response)
      await settled()
      expect((await assistantMessage(conversationId)).message).toMatchObject({
        status: 'failed',
        credits: 11,
      })
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 89, debt: 0 })
      await assertInvariant(me.workspaceId)
    })

    it.each(['local', 'remote', 'error'] as const)(
      '%s：英文长回复估算高于预扣，仅扣预扣额',
      async (path) => {
        const me = await member(`cap-${path}`, 100)
        // 预扣 ceil((10 + 256 × 10) / 1000) = 3；英文字符估算会超过真实 token 上限。
        const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 256)
        const gated = gatedModel({
          chunks: 160,
          gates: path === 'error' ? [] : [120],
          ...(path === 'error' ? { failAfter: 120 } : {}),
        })
        const { response, settled } = await begin(
          me,
          { modelId, text: 'hi' },
          { mock: gated.model },
        )
        const conversationId = response.headers.get('x-conversation-id') as string
        if (path !== 'error') {
          await gated.reached(120)
          const message = await until(
            async () => (await assistantMessage(conversationId)).message,
            (m) => (m.usage_checkpoint?.outputTokens ?? 0) >= 800,
          )
          expect(
            await stop(me, message.id, path === 'remote' ? { activeChats: new Map() } : {}),
          ).toEqual({
            status: 200,
            body: { status: 'aborted' },
          })
          gated.open(120)
        }
        await bodyText(response)
        await settled()
        const { message } = await assertCapped(me.workspaceId, conversationId, 3)
        expect(message.status).toBe(path === 'error' ? 'failed' : 'aborted')
        expect(message.output_tokens).toBeGreaterThan(256)
      },
    )

    it.each(['input', 'output'] as const)(
      '正常结束缺少 %s usage 时仍是封顶估算',
      async (missing) => {
        const me = await member(`cap-missing-${missing}`, 100)
        const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 256)
        const { response } = await send(
          me,
          { modelId, text: 'hi' },
          {
            mock: mockModel('abcdefgh'.repeat(120), {
              input: missing === 'input' ? undefined : 10,
              output: missing === 'output' ? undefined : 960,
            }),
          },
        )
        const { message } = await assertCapped(
          me.workspaceId,
          response.headers.get('x-conversation-id') as string,
          3,
        )
        expect(message.status).toBe('completed')
      },
    )

    it.each(['checkpoint', 'minimum'] as const)(
      '超时兜底 %s：有正文封顶预扣，无正文全退',
      async (path) => {
        const me = await member(`cap-sweep-${path}`, 100)
        const conversationId = newId()
        const messageId = newId()
        const pricing = { mode: 'token' as const, inputPer1k: 1, outputPer1k: 10, minCharge: 5 }
        const reservation = await hold(db, {
          workspaceId: me.workspaceId,
          userId: me.userId,
          amount: 2,
          refType: 'ai_message',
          refId: messageId,
          expiresAt: new Date(Date.now() - 1),
        })
        const s = scoped(db, me.workspaceId)
        await s.insert(aiConversation, {
          id: conversationId,
          userId: me.userId,
          title: 'timeout',
          modelKey: 'mock-timeout',
        })
        await s.insert(aiMessage, {
          id: messageId,
          conversationId,
          role: 'assistant',
          status: 'streaming',
          pricing,
          inputTokens: 10,
          holdId: reservation.id,
          parts: path === 'checkpoint' ? [{ type: 'text', text: 'abcdefgh'.repeat(120) }] : [],
          usageCheckpoint:
            path === 'checkpoint'
              ? { inputTokens: 10, outputTokens: 960, at: new Date().toISOString() }
              : null,
        })
        await db.transaction(async (tx) => {
          const [expired] = await scoped(tx, me.workspaceId)
            .select(creditHold, { where: eq(creditHold.id, reservation.id) })
            .limit(1)
          if (!expired) throw new Error('hold missing')
          await chatHoldSweeper({ overage: OVERAGE })({ db, tx, hold: expired })
        })
        const { message, hold: reservationResult } =
          path === 'checkpoint'
            ? await assertCapped(me.workspaceId, conversationId, 2)
            : await assistantMessage(conversationId)
        if (path === 'minimum') {
          expect(message.credits).toBe(0)
          expect(reservationResult?.status).toBe('released')
          expect(await consumeLedger(me.workspaceId)).toEqual([])
          await assertInvariant(me.workspaceId)
        }
        expect(message.status).toBe('failed')
        expect(message.output_tokens).toBe(path === 'checkpoint' ? 960 : 0)
      },
    )
  })

  describe('reasoning 重试与原生续写', () => {
    const tokenPricing = { mode: 'token' as const, inputPer1k: 10, outputPer1k: 10 }
    const callPricing = {
      mode: 'per_call' as const,
      credits: 3,
      limits: { maxInputTokens: 4000, maxOutputTokens: 1000 },
    }
    const policy = (options: Partial<TemplateConfig['ai']['text']> = {}) => ({
      ...defineTemplateConfig({
        app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      }).ai.text,
      ...options,
    })

    async function resilientModel(pricing: AiPricingJson, thinking = true, continuation = true) {
      const id = await textModel(pricing, 1000)
      await db
        .update(aiModel)
        .set({
          provider: 'deepseek',
          paramsSchema: {
            'x-text': {
              maxOutputTokens: 1000,
              thinking,
              continuation: continuation ? 'native' : 'none',
            },
          },
        })
        .where(eq(aiModel.id, id))
      return id
    }

    /** 每次上游调用用一段独立脚本，断开保留此前真正下发的正文。 */
    function attempts(scripts: { text?: string; reasoning?: string; fail?: boolean }[]) {
      let attempt = 0
      return new MockLanguageModelV4({
        doStream: async () => {
          const script = scripts[attempt++]
          if (!script) throw new Error('unexpected extra attempt')
          const chunks = []
          if (script.reasoning)
            chunks.push(
              { type: 'reasoning-start' as const, id: 'r' },
              { type: 'reasoning-delta' as const, id: 'r', delta: script.reasoning },
              { type: 'reasoning-end' as const, id: 'r' },
            )
          if (script.text)
            chunks.push(
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: script.text },
              { type: 'text-end' as const, id: 't' },
            )
          if (script.fail)
            chunks.push({ type: 'error' as const, error: new Error('provider disconnected') })
          else
            chunks.push({
              ...USAGE_FINISH(100, 200),
              usage: {
                inputTokens: {
                  total: 100,
                  noCache: 100,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 200,
                  text: script.text ? 150 : 0,
                  reasoning: script.reasoning ? 50 : 0,
                },
              },
            })
          return {
            stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
          }
        },
      })
    }

    it('仅 reasoning 后成功：同一预扣重试，仅保存最终 reasoning 与成功用量', async () => {
      const me = await member('reasoning-retry', 100)
      const modelId = await resilientModel(tokenPricing)
      const mock = attempts([
        { reasoning: 'discarded thought' },
        { reasoning: 'final thought', text: 'answer' },
      ])
      const { response, stream } = await send(
        me,
        { modelId, text: 'hi' },
        {
          factory: () => mock,
          textConfig: policy({ reasoning: { display: true } }),
        },
      )
      const conversationId = response.headers.get('x-conversation-id') as string
      const { message, hold: reservation } = await assistantMessage(conversationId)
      expect(mock.doStreamCalls).toHaveLength(2)
      expect(streamedText(stream)).toBe('answer')
      expect(stream).toContain('"type":"data-retry"')
      expect(message).toMatchObject({
        status: 'completed',
        credits: 3,
        input_tokens: 100,
        output_tokens: 200,
        parts: [
          { type: 'reasoning', text: 'final thought' },
          { type: 'text', text: 'answer' },
        ],
        usage_checkpoint: {
          reasoningTokens: 50,
          absorbed: { inputTokens: 100, outputTokens: 200, reasoningTokens: 50 },
        },
      })
      expect(reservation).toMatchObject({ status: 'captured', captured_amount: 3 })
      const [counts] = await sql<{ messages: number; holds: number }[]>`
        select (select count(*)::int from ai_message where conversation_id=${conversationId} and role='assistant') as messages,
          (select count(*)::int from credit_hold where workspace_id=${me.workspaceId}) as holds`
      expect(counts).toEqual({ messages: 1, holds: 1 })
      await assertInvariant(me.workspaceId)
    })

    it.each([tokenPricing, callPricing])('仅 reasoning 重试耗尽免费：$mode', async (pricing) => {
      const me = await member('reasoning-exhausted', 100)
      const modelId = await resilientModel(pricing)
      const mock = attempts(Array.from({ length: 3 }, () => ({ reasoning: 'hidden thought' })))
      const { response, stream } = await send(me, { modelId, text: 'hi' }, { factory: () => mock })
      expect(mock.doStreamCalls).toHaveLength(3)
      expect(stream.match(/"type":"data-retry"/g)).toHaveLength(2)
      expect(stream).not.toContain('hidden thought')
      expect(
        await assistantMessage(response.headers.get('x-conversation-id') as string),
      ).toMatchObject({
        message: { status: 'failed', parts: [], credits: 0 },
        hold: { status: 'released' },
      })
      expect(await consumeLedger(me.workspaceId)).toEqual([])
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
      await assertInvariant(me.workspaceId)
    })

    it('有正文中断后原生续写：正文连续追加且仅结算一次', async () => {
      const me = await member('native-continuation', 100)
      const modelId = await resilientModel(callPricing)
      const mock = attempts([{ text: 'first ', fail: true }, { text: 'second' }])
      const { response, stream } = await send(me, { modelId, text: 'hi' }, { factory: () => mock })
      expect(mock.doStreamCalls).toHaveLength(2)
      expect(mock.doStreamCalls[1]?.prompt.at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'first ' }],
        providerOptions: { deepseek: { prefix: true } },
      })
      expect(streamedText(stream)).toBe('first second')
      expect(
        await assistantMessage(response.headers.get('x-conversation-id') as string),
      ).toMatchObject({
        message: {
          status: 'completed',
          parts: [{ type: 'text', text: 'first second' }],
          credits: 3,
        },
        hold: { status: 'captured', captured_amount: 3 },
      })
      expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -3 }])
      await assertInvariant(me.workspaceId)
    })

    it.each(['no-visible-output', 'all'] as const)(
      '续写耗尽 %s：保存正文，失败全退开关决定收费',
      async (failedReplyRefund) => {
        const me = await member('continuation-failed', 100)
        const modelId = await resilientModel(callPricing)
        const mock = attempts([
          { text: 'partial', reasoning: 'private thought', fail: true },
          { fail: true },
          { fail: true },
        ])
        const { response } = await send(
          me,
          { modelId, text: 'hi' },
          {
            factory: () => mock,
            textConfig: policy({ failedReplyRefund, reasoning: { display: true } }),
          },
        )
        const conversationId = response.headers.get('x-conversation-id') as string
        const { message, hold: reservation } = await assistantMessage(conversationId)
        expect(mock.doStreamCalls).toHaveLength(3)
        const credits = failedReplyRefund === 'all' ? 0 : 3
        expect(message).toMatchObject({ status: 'failed', credits })
        expect(message.parts).toContainEqual({ type: 'text', text: 'partial' })
        expect(reservation?.status).toBe(credits ? 'captured' : 'released')
        // 模型下一轮看到用户已经看到的 failed 正文，reasoning 始终隔离。
        const next = attempts([{ text: 'next answer' }])
        await send(me, { modelId, text: 'continue', conversationId }, { factory: () => next })
        const history = JSON.stringify(next.doStreamCalls[0]?.prompt)
        expect(history).toContain('partial')
        expect(history).not.toContain('private thought')
        await assertInvariant(me.workspaceId)
      },
    )

    it.each(['off', 'on'] as const)(
      'DeepSeek 空 schema 仍按模板 %s 显式下发 thinking',
      async (defaultThinking) => {
        const me = await member(`thinking-default-${defaultThinking}`, 100)
        const modelId = await resilientModel(callPricing)
        await db.update(aiModel).set({ paramsSchema: {} }).where(eq(aiModel.id, modelId))
        const mock = attempts([{ text: 'answer' }])
        const { response } = await send(
          me,
          { modelId, text: 'hi' },
          {
            factory: () => mock,
            textConfig: policy({ thinking: { default: defaultThinking, userToggle: false } }),
          },
        )
        expect(response.status).toBe(200)
        expect(mock.doStreamCalls[0]?.providerOptions).toMatchObject({
          deepseek: { thinking: { type: defaultThinking === 'on' ? 'enabled' : 'disabled' } },
        })
      },
    )

    it('DeepSeek 空 schema 接受用户逐条开启 thinking', async () => {
      const me = await member('thinking-adapter-policy', 100)
      const modelId = await resilientModel(callPricing)
      await db.update(aiModel).set({ paramsSchema: {} }).where(eq(aiModel.id, modelId))
      const on = attempts([{ text: 'on' }])
      const config = policy({ thinking: { default: 'off', userToggle: true } })
      await send(
        me,
        { modelId, text: 'hi', thinking: true },
        { factory: () => on, textConfig: config },
      )
      expect(on.doStreamCalls[0]?.providerOptions).toMatchObject({
        deepseek: { thinking: { type: 'enabled' } },
      })
    })

    it('无适配器 Provider 忽略显式 thinking 支持声明与请求开关', async () => {
      const me = await member('thinking-no-adapter', 100)
      const modelId = await resilientModel(callPricing)
      const config = policy({ thinking: { default: 'on', userToggle: true } })
      await db
        .update(aiModel)
        .set({ provider: 'openai', paramsSchema: { 'x-text': { thinking: true } } })
        .where(eq(aiModel.id, modelId))
      const plain = attempts([{ text: 'plain' }])
      await send(
        me,
        { modelId, text: 'hi', thinking: true },
        { factory: () => plain, textConfig: config },
      )
      expect(plain.doStreamCalls[0]?.providerOptions?.deepseek).toBeUndefined()
      expect(plain.doStreamCalls[0]?.reasoning).toBeUndefined()
    })

    it('thinking 按模板与单条请求映射；禁止切换时拒绝，不支持的模型忽略', async () => {
      const me = await member('thinking-policy', 100)
      const modelId = await resilientModel(callPricing)
      const denied = attempts([{ text: 'unused' }])
      expect(
        (await send(me, { modelId, text: 'hi', thinking: true }, { factory: () => denied }))
          .response.status,
      ).toBe(400)
      expect(denied.doStreamCalls).toHaveLength(0)
      const off = attempts([{ text: 'off' }])
      await send(me, { modelId, text: 'hi' }, { factory: () => off })
      expect(off.doStreamCalls[0]?.providerOptions).toMatchObject({
        deepseek: { thinking: { type: 'disabled' } },
      })
      const on = attempts([{ text: 'on' }])
      await send(
        me,
        { modelId, text: 'hi', thinking: true },
        {
          factory: () => on,
          textConfig: policy({ thinking: { default: 'off', userToggle: true } }),
        },
      )
      expect(on.doStreamCalls[0]?.providerOptions).toMatchObject({
        deepseek: { thinking: { type: 'enabled' } },
      })
      const unsupportedId = await resilientModel(callPricing, false)
      const unsupported = attempts([{ reasoning: 'hidden', text: 'plain' }])
      const { response, stream } = await send(
        me,
        { modelId: unsupportedId, text: 'hi', thinking: true },
        {
          factory: () => unsupported,
          textConfig: policy({ thinking: { default: 'on', userToggle: true } }),
        },
      )
      expect(unsupported.doStreamCalls[0]?.providerOptions?.deepseek).toBeUndefined()
      expect(stream).not.toContain('hidden')
      expect(
        (await assistantMessage(response.headers.get('x-conversation-id') as string)).message.parts,
      ).toEqual([{ type: 'text', text: 'plain' }])
    })
  })

  describe('用量检查点（tasks 2.5）', () => {
    it('长流每 200 个输出 token 写入检查点与已生成内容；正常完成时以最终 usage 结算', async () => {
      const me = await member('checkpoint', 1000)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 4900)
      const gated = gatedModel({ chunks: 60, gates: [30, 55], usage: { input: 300, output: 999 } })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      const conversationId = response.headers.get('x-conversation-id') as string
      const read = async () => (await assistantMessage(conversationId)).message

      // 消息创建时已写入 0 输出的初始检查点，必须等到 200 token 检查点；闸门停在 30 块（240 token），
      // 下一个检查点（400）在开闸前不可能出现，等到的状态是稳定的。
      await gated.reached(30)
      const first = await until(read, (m) => m.usage_checkpoint?.outputTokens === 200)
      expect(first).toMatchObject({
        status: 'streaming',
        usage_checkpoint: { inputTokens: 10, outputTokens: 200 },
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
      })

      gated.open(30)
      await gated.reached(55)
      const second = await until(read, (m) => m.usage_checkpoint?.outputTokens === 400)
      expect(second.parts).toEqual([{ type: 'text', text: 'abcdefgh'.repeat(50) }])
      expect(Date.parse(second.usage_checkpoint?.at ?? '')).toBeGreaterThanOrEqual(
        Date.parse(first.usage_checkpoint?.at ?? ''),
      )

      gated.open(55)
      expect(streamedText(await bodyText(response))).toBe('abcdefgh'.repeat(60))
      await settled()
      // 最终 usage：ceil((300 × 1 + 999 × 10) / 1000) = 11，与检查点（400 token）无关
      const { message, hold } = await assistantMessage(conversationId)
      expect(message).toMatchObject({
        status: 'completed',
        credits: 11,
        input_tokens: 300,
        output_tokens: 999,
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(60) }],
      })
      expect(hold).toMatchObject({ status: 'captured', captured_amount: 11 })
      // 预扣带 10 分钟有效期，供兜底处理器回收
      const ttl = new Date(hold?.expires_at ?? 0).getTime() - Date.now()
      expect(ttl).toBeGreaterThan(9 * 60_000)
      expect(ttl).toBeLessThanOrEqual(10 * 60_000)
    })
  })

  describe('client response cancellation', () => {
    it('continues server consumption and settles full usage after the response reader disconnects', async () => {
      const me = await member('disconnected', 100)
      const modelId = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 }, 1000)
      const gated = gatedModel({ chunks: 60, gates: [30], usage: { input: 300, output: 999 } })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      expect(response.status).toBe(200)
      const conversationId = response.headers.get('x-conversation-id') as string
      if (!response.body) throw new Error('Missing chat response stream')
      const reader = response.body.getReader()
      await reader.read()
      await gated.reached(30)
      const disconnected = reader.cancel()
      gated.open(30)
      await settled()
      await disconnected
      const { message, hold } = await assistantMessage(conversationId)
      expect(message).toMatchObject({
        status: 'completed',
        credits: 11,
        input_tokens: 300,
        output_tokens: 999,
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(60) }],
      })
      expect(hold).toMatchObject({ status: 'captured', captured_amount: 11 })
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 89, held: 0 })
      expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -11 }])
    })
  })

  describe('POST /api/ai/chat/:messageId/stop（tasks 2.4）', () => {
    it('按 token 停止（同 isolate）：中止生成，保留已生成部分并按已产生用量结算；再次停止幂等', async () => {
      const me = await member('stop-token', 1000)
      // 预扣 = ceil((10 × 10 + 1000 × 100) / 1000) = 101
      const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 100 }, 1000)
      const gated = gatedModel({ chunks: 60, gates: [10] })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      const conversationId = response.headers.get('x-conversation-id') as string
      const messageId = (await assistantMessage(conversationId)).message.id
      await gated.reached(10)

      expect(await stop(me, messageId)).toEqual({ status: 200, body: { status: 'aborted' } })
      await bodyText(response)
      await settled()
      // 已生成 80 个字符 ≈ 80 输出 token：ceil((10 × 10 + 80 × 100) / 1000) = 9
      const { message, hold } = await assistantMessage(conversationId)
      expect(message).toMatchObject({
        status: 'aborted',
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(10) }],
        input_tokens: 10,
        output_tokens: 80,
        credits: 9,
      })
      expect(hold).toMatchObject({ status: 'captured', amount: 101, captured_amount: 9 })
      expect((await getCreditBalance(db, me.workspaceId)).available).toBe(991)

      expect(await stop(me, messageId)).toEqual({ status: 200, body: { status: 'aborted' } })
      expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -9 }])
    })

    it('跨 isolate 停止（按次）：按已持久化的检查点结算并标记 aborted，原流随后中止且不重复结算', async () => {
      const me = await member('stop-remote', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 2000 },
      })
      const gated = gatedModel({ chunks: 120, gates: [30] })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      const conversationId = response.headers.get('x-conversation-id') as string
      const read = async () => (await assistantMessage(conversationId)).message
      await gated.reached(30)
      // 跳过创建时的 0 输出初始检查点，等到闸门前稳定的 200 token 检查点再跨 isolate 停止
      const { id: messageId } = await until(read, (m) => m.usage_checkpoint?.outputTokens === 200)

      // 停止请求落在没有该流的 isolate
      expect(await stop(me, messageId, { activeChats: new Map() })).toEqual({
        status: 200,
        body: { status: 'aborted' },
      })
      const stopped = await assistantMessage(conversationId)
      expect(stopped.message).toMatchObject({
        status: 'aborted',
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
        credits: 3,
      })
      expect(stopped.hold).toMatchObject({ status: 'captured', captured_amount: 3 })

      // 原流继续：下一个检查点发现消息已结束即中止，结束时的结算被预扣状态闸门跳过
      gated.open(30)
      const streamed = streamedText(await bodyText(response))
      await settled()
      expect(streamed.length).toBeLessThan(120 * 8)
      expect(await read()).toMatchObject({
        status: 'aborted',
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(25) }],
        credits: 3,
      })
      expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -3 }])
      expect((await getCreditBalance(db, me.workspaceId)).available).toBe(97)
    })

    it('按次在产生输出前停止：释放预扣', async () => {
      const me = await member('stop-empty', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const gated = gatedModel({ chunks: 10, gates: [0] })
      const { response, settled } = await begin(me, { modelId, text: 'hi' }, { mock: gated.model })
      const conversationId = response.headers.get('x-conversation-id') as string
      await gated.reached(0)
      const { message } = await assistantMessage(conversationId)
      expect(await stop(me, message.id)).toEqual({ status: 200, body: { status: 'aborted' } })
      await bodyText(response)
      await settled()
      expect(await assistantMessage(conversationId)).toMatchObject({
        message: { status: 'aborted', parts: [], credits: 0 },
        hold: { status: 'released' },
      })
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
    })

    it('已完成的消息幂等返回 completed；他人消息或不存在返回 404', async () => {
      const owner = await member('stop-owner', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 1,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const { response } = await send(
        owner,
        { modelId, text: 'hi' },
        { mock: mockModel('done', { input: 5, output: 1 }) },
      )
      const { message } = await assistantMessage(
        response.headers.get('x-conversation-id') as string,
      )
      expect(await stop(owner, message.id)).toEqual({ status: 200, body: { status: 'completed' } })

      const other = await member('stop-other')
      await db.insert(memberTable).values({
        id: newId(),
        organizationId: owner.workspaceId,
        userId: other.userId,
        role: 'admin',
      })
      const peek = await stop({ slug: owner.slug, cookie: other.cookie }, message.id)
      expect(peek).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } })
      expect((await stop(owner, newId())).status).toBe(404)
      expect((await stop(owner, 'not-a-uuid')).status).toBe(404)
    })
  })

  describe('staging 文本故障包装（tasks 4.1、4.2）', () => {
    const faultEnv = { AI_FAULT_INJECTION: 'enabled' as const, SENTRY_ENVIRONMENT: 'staging' }
    const pricingOptions = {
      token: { mode: 'token' as const, inputPer1k: 10, outputPer1k: 100, minCharge: 2 },
      per_call: {
        mode: 'per_call' as const,
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 4096 },
      },
    }

    async function administrator(name: string) {
      const me = await member(name, 100)
      await sql`update "user" set role='admin' where id=${me.userId}`
      // 去掉登录时普通角色的 Cookie 缓存，让入口同时读取实时管理员身份。
      const context = await auth.$context
      const tokenName = context.authCookies.sessionToken.name
      return {
        ...me,
        cookie: me.cookie
          .split('; ')
          .filter((cookie) => cookie.startsWith(`${tokenName}=`))
          .join('; '),
      }
    }

    async function faultModel(
      mode: 'chat-before-stream' | 'chat-mid-stream',
      pricing: AiPricingJson,
      maxOutputTokens = 4096,
    ) {
      const id = newId()
      await db.insert(aiModel).values({
        id,
        key: `${FAULT_KEY_PREFIX}${id}`,
        kind: 'text',
        provider: 'deepseek',
        providerModelId: 'deepseek-flash',
        pricing,
        paramsSchema: {
          'x-acceptance-fault': { mode },
          'x-text': { maxOutputTokens },
        },
      })
      return id
    }

    /** pull 模拟上游：取消即停止产出，记录业务 AbortController 是否被误当成用户 stop。 */
    function upstream(options: {
      chunks: number
      failAfter?: number
      delta?: string
      gate?: Promise<void>
    }) {
      let cancelled = 0
      let signal: AbortSignal | undefined
      const delta = options.delta ?? 'abcdefgh'
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          signal = abortSignal
          let index = -1
          return {
            stream: new ReadableStream({
              async pull(controller) {
                if (index === -1) {
                  await options.gate
                  index++
                  controller.enqueue({ type: 'text-start', id: 't1' })
                } else if (index === options.failAfter) {
                  controller.error(new Error('natural provider disconnect'))
                } else if (index < options.chunks) {
                  index++
                  controller.enqueue({ type: 'text-delta', id: 't1', delta })
                } else {
                  controller.enqueue({ type: 'text-end', id: 't1' })
                  controller.enqueue(USAGE_FINISH(10, options.chunks * delta.length))
                  controller.close()
                }
              },
              cancel() {
                cancelled++
              },
            }),
          }
        },
      })
      // Node 普通模型使用固定 OpenAI transport；此工厂保留合法 DeepSeek 元数据，
      // 两个运行目标都让生产 chat 的故障包装器处理同一真实 SDK 流。
      return {
        model,
        factory: () => model,
        cancelled: () => cancelled,
        aborted: () => signal?.aborted,
      }
    }

    it.each([
      ['chat-before-stream', 'token'],
      ['chat-before-stream', 'per_call'],
      ['chat-mid-stream', 'token'],
      ['chat-mid-stream', 'per_call'],
    ] as const)('%s / %s：故障证明、差异化收费与重复结算', async (mode, kind) => {
      const me = await administrator(`fault-${mode}-${kind}`)
      const pricing = pricingOptions[kind]
      const modelId = await faultModel(mode, pricing)
      const source = upstream({ chunks: 60 })
      const { response, stream } = await send(
        me,
        { modelId, text: 'hi' },
        {
          factory: source.factory,
          env: faultEnv,
        },
      )
      expect(response.status).toBe(200)
      const conversationId = response.headers.get('x-conversation-id') as string
      const result = await assistantMessage(conversationId)
      const mid = mode === 'chat-mid-stream'
      const output = mid ? 'abcdefgh'.repeat(25) : ''
      const charged = mid ? (kind === 'token' ? 21 : 3) : 0
      expect(streamedText(stream)).toBe(output)
      expect(result.message).toMatchObject({
        status: 'failed',
        parts: mid ? [{ type: 'text', text: output }] : [],
        credits: charged,
        pricing,
        usage_checkpoint: {
          inputTokens: 10,
          outputTokens: mid ? 200 : 0,
          acceptanceFaultProof: {
            mode,
            policyVersion: 1,
            phase: mid ? 'mid-stream' : 'before-stream',
            injected: true,
            realProviderCalled: mid,
            upstreamCalls: mid ? 1 : 0,
          },
        },
      })
      expect(result.message.usage_checkpoint?.acceptanceFaultProof?.injectedAt).toEqual(
        expect.any(String),
      )
      expect(result.hold).toMatchObject({
        status: charged ? 'captured' : 'released',
        amount: kind === 'token' ? 100 : 3,
        captured_amount: charged,
        overage_absorbed: 0,
        overage_debited: 0,
        overage_debt: 0,
      })
      expect(source.model.doStreamCalls).toHaveLength(mid ? 1 : 0)
      if (mid) {
        expect(source.model.doStreamCalls[0]?.maxOutputTokens).toBe(kind === 'token' ? 999 : 1024)
        expect(source.cancelled()).toBe(1)
        expect(source.aborted()).toBe(false)
      }
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({
        available: 100 - charged,
        held: 0,
        debt: 0,
      })
      expect(await consumeLedger(me.workspaceId)).toEqual(charged ? [{ delta: -charged }] : [])
      expect(await reconcileWorkspaceCredits(db, me.workspaceId)).toMatchObject({
        consistent: true,
        difference: 0,
        held: 0,
        debt: 0,
      })

      const before =
        await sql`select * from credit_ledger where workspace_id=${me.workspaceId} order by id`
      expect(
        await settleInterruptedChatMessage(db, {
          workspaceId: me.workspaceId,
          messageId: result.message.id,
          holdId: result.message.hold_id,
          pricing,
          overage: OVERAGE,
          usageSource: 'estimated',
          status: 'failed',
          inputTokens: 10,
          outputTokens: mid ? 200 : 0,
          text: output,
          hasOutput: mid,
        }),
      ).toBeNull()
      expect(await assistantMessage(conversationId)).toEqual(result)
      expect(
        await sql`select * from credit_ledger where workspace_id=${me.workspaceId} order by id`,
      ).toEqual(before)
    })

    it('上游尚未产出时仅保存输入预算与未注入证明，不提前持久化输出', async () => {
      const me = await administrator('fault-initial-checkpoint')
      const modelId = await faultModel('chat-mid-stream', pricingOptions.per_call)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const source = upstream({ chunks: 60, gate })
      const { response, settled } = await begin(
        me,
        { modelId, text: 'hi' },
        { factory: source.factory, env: faultEnv },
      )
      const conversationId = response.headers.get('x-conversation-id') as string
      try {
        const message = await until(
          async () => (await assistantMessage(conversationId)).message,
          (message) => message.usage_checkpoint?.acceptanceFaultProof?.upstreamCalls === 1,
        )
        expect(message).toMatchObject({
          status: 'streaming',
          parts: [],
          input_tokens: 10,
          usage_checkpoint: {
            inputTokens: 10,
            outputTokens: 0,
            acceptanceFaultProof: { injected: false, realProviderCalled: true, upstreamCalls: 1 },
          },
        })
      } finally {
        release()
        await bodyText(response)
        await settled()
      }
    })

    it('流中单块超过预扣：估算封顶且不产生超额或欠费', async () => {
      const me = await administrator('fault-cap')
      const modelId = await faultModel('chat-mid-stream', pricingOptions.token, 256)
      const source = upstream({ chunks: 2, delta: 'abcdefgh'.repeat(120) })
      const { response } = await send(
        me,
        { modelId, text: 'hi' },
        { factory: source.factory, env: faultEnv },
      )
      const conversationId = response.headers.get('x-conversation-id') as string
      const { message } = await assertCapped(me.workspaceId, conversationId, 26)
      expect(message).toMatchObject({
        status: 'failed',
        output_tokens: 960,
        usage_checkpoint: {
          outputTokens: 960,
          acceptanceFaultProof: { injected: true, outputTokens: 960 },
        },
      })
      expect(source.cancelled()).toBe(1)
      expect(await reconcileWorkspaceCredits(db, me.workspaceId)).toMatchObject({
        consistent: true,
        difference: 0,
      })
    })

    it.each(['short', 'natural-error'] as const)('%s：未达到阈值不认证故障注入', async (path) => {
      const me = await administrator(`fault-${path}`)
      const modelId = await faultModel('chat-mid-stream', pricingOptions.per_call)
      const source = upstream({ chunks: 10, ...(path === 'natural-error' ? { failAfter: 5 } : {}) })
      const { response, stream } = await send(
        me,
        { modelId, text: 'hi' },
        { factory: source.factory, env: faultEnv },
      )
      const { message } = await assistantMessage(
        response.headers.get('x-conversation-id') as string,
      )
      expect(message).toMatchObject({
        status: path === 'short' ? 'completed' : 'failed',
        parts: [{ type: 'text', text: 'abcdefgh'.repeat(path === 'short' ? 10 : 5) }],
        credits: 3,
        usage_checkpoint: {
          acceptanceFaultProof: {
            mode: 'chat-mid-stream',
            policyVersion: 1,
            phase: 'mid-stream',
            injected: false,
            realProviderCalled: true,
            upstreamCalls: 1,
          },
        },
      })
      expect(streamedText(stream)).toBe(message.parts[0]?.text)
      expect(message.usage_checkpoint?.acceptanceFaultProof?.injectedAt).toBeUndefined()
      expect(source.model.doStreamCalls).toHaveLength(1)
      expect(await consumeLedger(me.workspaceId)).toEqual([{ delta: -3 }])
    })
  })

  describe('出错结算（tasks 2.4）', () => {
    const failing = () =>
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error('provider unavailable')
        },
      })

    it('按次且无输出即出错：预扣全额退回，回复标记 failed', async () => {
      const me = await member('error-per-call', 100)
      const modelId = await textModel({
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 500 },
      })
      const { response } = await send(me, { modelId, text: 'hi' }, { mock: failing() })
      expect(
        await assistantMessage(response.headers.get('x-conversation-id') as string),
      ).toMatchObject({
        message: { status: 'failed', parts: [], credits: 0 },
        hold: { status: 'released' },
      })
      expect(await getCreditBalance(db, me.workspaceId)).toMatchObject({ available: 100, held: 0 })
      expect(await consumeLedger(me.workspaceId)).toEqual([])
    })

    it('按 token 且无输出即出错：预扣全退，不收 minCharge', async () => {
      const me = await member('error-token', 100)
      const modelId = await textModel(
        { mode: 'token', inputPer1k: 1, outputPer1k: 10, minCharge: 2 },
        1000,
      )
      const { response } = await send(me, { modelId, text: 'hi' }, { mock: failing() })
      expect(
        await assistantMessage(response.headers.get('x-conversation-id') as string),
      ).toMatchObject({
        message: { status: 'failed', parts: [], credits: 0 },
        hold: { status: 'released' },
      })
    })

    it('按 token 输出中途出错：保留部分内容，按已生成内容估算的用量结算', async () => {
      const me = await member('error-partial', 1000)
      const modelId = await textModel({ mode: 'token', inputPer1k: 10, outputPer1k: 100 }, 1000)
      const gated = gatedModel({ chunks: 60, gates: [], failAfter: 5 })
      const { response } = await send(me, { modelId, text: 'hi' }, { mock: gated.model })
      // ceil((10 × 10 + 40 × 100) / 1000) = 5
      expect(
        await assistantMessage(response.headers.get('x-conversation-id') as string),
      ).toMatchObject({
        message: {
          status: 'failed',
          parts: [{ type: 'text', text: 'abcdefgh'.repeat(5) }],
          output_tokens: 40,
          credits: 5,
        },
        hold: { status: 'captured', captured_amount: 5 },
      })
    })
  })
}
