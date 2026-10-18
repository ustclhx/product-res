import { env } from 'cloudflare:workers'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { getCreditBalance, grant } from '@product-res/credits'
import { type AiPricingJson, aiModel, createDb } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import type { RateLimiter } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import OpenAI from 'openai'
import { afterAll, describe, expect, it, vi } from 'vitest'
import enApiDoc from '../content/docs/en/public-api.mdx?raw'
import zhApiDoc from '../content/docs/zh/public-api.mdx?raw'
import { handleCompletions } from '../src/features/api-keys/completions.ts'
import {
  type ApiKeyDeps,
  authenticateApiKey,
  createWorkspaceKey,
  editWorkspaceKey,
  listWorkspaceKeys,
} from '../src/features/api-keys/service.ts'

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const domain = `${newId()}.public-api.example`
const prefix = `api-test-${newId()}-`
const url = 'http://localhost:3000'
const config = defineTemplateConfig({
  app: { name: 'Test', url, supportEmail: 'support@example.test' },
  auth: { oauth: [], turnstile: false },
  features: { publicApi: true },
})
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL: url },
  db,
  { config, sendEmail: async () => {} },
)
const entitlement = {
  key: 'test',
  sort: 0,
  features: { ...DEFAULT_FREE_FEATURES, publicApi: true, models: ['*'] },
}
const deps: ApiKeyDeps = { db, auth, config, entitlements: async () => entitlement }
const limiter: RateLimiter = { limit: async () => ({ success: true }) }
const authPost = (path: string, body: unknown) =>
  auth.handler(
    new Request(`${url}/api/auth${path}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
async function owner(credits = 1000) {
  const email = `${newId()}@${domain}`
  const response = await authPost('/sign-up/email', {
    email,
    password: 'correct-horse-battery-staple',
    name: 'API Owner',
  })
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const login = await authPost('/sign-in/email', {
    email,
    password: 'correct-horse-battery-staple',
  })
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const [workspace] = await sql<
    { slug: string }[]
  >`select slug from organization where id = ${user.id}`
  if (!workspace) throw new Error('Missing workspace')
  await grant(db, { workspaceId: user.id, amount: credits, source: 'admin', sourceRef: newId() })
  const headers = new Headers({ cookie })
  const key = await createWorkspaceKey(headers, { slug: workspace.slug, name: 'SDK' }, deps)
  return { id: user.id, slug: workspace.slug, headers, key }
}
function model() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'reasoning-start', id: 'reasoning' },
          {
            type: 'reasoning-delta',
            id: 'reasoning',
            delta: 'Private reasoning must stay private',
          },
          { type: 'reasoning-end', id: 'reasoning' },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: 'Hello SDK' },
          { type: 'text-end', id: 'text' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: {
                total: 200,
                noCache: 200,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1180, text: 1173, reasoning: 7 },
            },
          },
        ],
      }),
    }),
  })
}
function client(key: string, overrides: Partial<ApiKeyDeps & { rateLimiter: RateLimiter }> = {}) {
  const background: Promise<unknown>[] = []
  const mock = model()
  const apiDeps = {
    ...deps,
    rateLimiter: limiter,
    env: {},
    languageModelFactory: () => mock,
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
    ...overrides,
  }
  const sdk = new OpenAI({
    apiKey: key,
    baseURL: `${url}/api/v1`,
    maxRetries: 0,
    fetch: (input, init) => handleCompletions(new Request(input, init), apiDeps),
  })
  return { sdk, apiDeps, mock, settled: () => Promise.all(background) }
}
async function textModel(pricing: AiPricingJson) {
  const key = `${prefix}${newId()}`
  await db.insert(aiModel).values({
    key,
    kind: 'text',
    provider: 'mock',
    providerModelId: 'mock',
    pricing,
    paramsSchema: { 'x-text': { maxOutputTokens: 4900 } },
  })
  return key
}
const request = (key?: string, body: unknown = {}) =>
  new Request(`${url}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  })

afterAll(async () => {
  const ids = sql`select id from "user" where email like ${`%@${domain}`}`
  await sql`delete from ai_message where workspace_id in (${ids})`
  await sql`delete from ai_conversation where workspace_id in (${ids})`
  await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id in (${ids}))`
  await sql`delete from credit_ledger where workspace_id in (${ids})`
  await sql`delete from credit_hold where workspace_id in (${ids})`
  await sql`delete from credit_grant where workspace_id in (${ids})`
  await sql`delete from credit_debt where workspace_id in (${ids})`
  await sql`delete from apikey where reference_id in (${ids})`
  await sql`delete from session where user_id in (${ids})`
  await sql`delete from account where user_id in (${ids})`
  await sql`delete from member where user_id in (${ids})`
  await sql`delete from organization where id in (${ids})`
  await sql`delete from "user" where id in (${ids})`
  await sql`delete from ai_model where key like ${`${prefix}%`}`
})

describe('公开 API Key 管理与鉴权', () => {
  it('完整值只从创建返回，空间管理员可以命名与撤销；撤销后 SDK 返回 401', async () => {
    const who = await owner()
    const listed = await listWorkspaceKeys(who.headers, who.slug, 0, deps)
    expect(listed.rows[0]).toMatchObject({ id: who.key.id, name: 'SDK' })
    expect(listed.rows[0]).not.toHaveProperty('key')
    await editWorkspaceKey(who.headers, { slug: who.slug, id: who.key.id, name: 'Renamed' }, deps)
    expect((await listWorkspaceKeys(who.headers, who.slug, 0, deps)).rows[0]?.name).toBe('Renamed')
    await editWorkspaceKey(who.headers, { slug: who.slug, id: who.key.id, revoke: true }, deps)
    await expect(
      client(who.key.key).sdk.chat.completions.create({
        model: 'anything',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_API_KEY' })
  })
  it('原生 HTTP create/update 被关闭，不能用 metadata 换到其他空间', async () => {
    const a = await owner(),
      b = await owner()
    for (const path of ['/api-key/create', '/api-key/update']) {
      const response = await auth.handler(
        new Request(`${url}/api/auth${path}`, {
          method: 'POST',
          headers: a.headers,
          body: JSON.stringify({
            keyId: a.key.id,
            name: 'attack',
            metadata: { workspaceId: b.id },
          }),
        }),
      )
      expect(response.status).toBe(404)
    }
    const result = await authenticateApiKey(request(a.key.key), { ...deps, rateLimiter: limiter })
    expect(result.workspace.id).toBe(a.id)
    await expect(
      editWorkspaceKey(a.headers, { slug: a.slug, id: b.key.id, revoke: true }, deps),
    ).rejects.toMatchObject({ status: 404 })
  })
  it('空间 admin 可管理该空间中其他创建者的密钥，创建时可设置到期时间', async () => {
    const who = await owner(),
      admin = await owner()
    await sql`insert into member (id, organization_id, user_id, role, created_at)
      values (${newId()}, ${who.id}, ${admin.id}, 'admin', now())`
    const expiresAt = new Date(Date.now() + 3600_000).toISOString()
    const created = await createWorkspaceKey(
      admin.headers,
      { slug: who.slug, name: 'Expiring', expiresAt },
      deps,
    )
    const listed = await listWorkspaceKeys(admin.headers, who.slug, 0, deps)
    expect(listed.rows.find((row) => row.id === created.id)?.expiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    )
    await editWorkspaceKey(admin.headers, { slug: who.slug, id: who.key.id, revoke: true }, deps)
    expect(
      (await handleCompletions(request(who.key.key), client(who.key.key).apiDeps)).status,
    ).toBe(401)
    const context = await authenticateApiKey(request(created.key), {
      ...deps,
      rateLimiter: limiter,
    })
    expect(context.workspace.id).toBe(who.id)
    expect(context.user.id).toBe(admin.id)
  })
  it('普通成员无法管理或使用降权前创建的 Key，过期 Key 返回 401', async () => {
    const who = await owner()
    await sql`update apikey set expires_at = now() - interval '1 second' where id = ${who.key.id}`
    expect(
      (await handleCompletions(request(who.key.key), client(who.key.key).apiDeps)).status,
    ).toBe(401)
    await sql`update apikey set expires_at = null where id = ${who.key.id}`
    await sql`update member set role = 'member' where user_id = ${who.id}`
    await expect(
      createWorkspaceKey(who.headers, { slug: who.slug, name: 'No' }, deps),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      (await handleCompletions(request(who.key.key), client(who.key.key).apiDeps)).status,
    ).toBe(401)
  })
  it('关闭功能返回 404；无 Bearer 时 Cookie 不放行；无权益返回 403；按 Key 和空间限流带 Retry-After', async () => {
    const who = await owner()
    const disabled = defineTemplateConfig({ app: config.app, features: { publicApi: false } })
    expect(
      (
        await handleCompletions(
          request(who.key.key),
          client(who.key.key, { config: disabled }).apiDeps,
        )
      ).status,
    ).toBe(404)
    const cookieOnly = request()
    cookieOnly.headers.set('cookie', who.headers.get('cookie') as string)
    expect((await handleCompletions(cookieOnly, client(who.key.key).apiDeps)).status).toBe(401)
    const denied = client(who.key.key, {
      entitlements: async () => ({
        ...entitlement,
        features: { ...entitlement.features, publicApi: false },
      }),
    })
    expect((await handleCompletions(request(who.key.key), denied.apiDeps)).status).toBe(403)
    const keys: string[] = []
    const limited = client(who.key.key, {
      rateLimiter: {
        limit: async (policy, key) => {
          expect(policy).toBe('api')
          keys.push(key)
          return { success: !key.startsWith('api:workspace:') }
        },
      },
    })
    const response = await handleCompletions(request(who.key.key), limited.apiDeps)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(keys).toEqual([`api:key:${who.key.id}`, `api:workspace:${who.id}`])
  })
})

describe('官方 OpenAI Node SDK 与共用积分结算', () => {
  it('平台管理员创建的 Key 在 staging 开启故障时仍不可选文本故障模型，且无业务或积分副作用', async () => {
    const who = await owner()
    await sql`update "user" set role='admin' where id=${who.id}`
    const key = await createWorkspaceKey(
      who.headers,
      { slug: who.slug, name: 'Admin fault denied' },
      deps,
    )
    const modelKey = `acceptance-fault-${newId()}`
    try {
      await db.insert(aiModel).values({
        key: modelKey,
        kind: 'text',
        provider: 'deepseek',
        providerModelId: 'deepseek-flash',
        pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 2 },
        paramsSchema: { 'x-acceptance-fault': { mode: 'chat-before-stream' } },
      })
      const languageModelFactory = vi.fn(() => model())
      const apiDeps = {
        ...client(key.key).apiDeps,
        env: { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'enabled' },
        languageModelFactory,
        // 即使内部依赖允许故障，公开入口也必须覆盖为拒绝。
        faultAccess: { enabled: true, platformAdmin: true },
      }
      const context = await authenticateApiKey(request(key.key), apiDeps)
      expect(context.user).toMatchObject({ id: who.id, role: 'admin' })
      const response = await handleCompletions(
        request(key.key, {
          model: modelKey,
          messages: [{ role: 'user', content: 'Fixture' }],
        }),
        apiDeps,
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'MODEL_UNAVAILABLE' } })
      expect(languageModelFactory).not.toHaveBeenCalled()
      expect(await sql`select id from ai_conversation where workspace_id=${who.id}`).toHaveLength(0)
      expect(await sql`select id from ai_message where workspace_id=${who.id}`).toHaveLength(0)
      expect(await sql`select id from ai_task where workspace_id=${who.id}`).toHaveLength(0)
      expect(await sql`select id from credit_hold where workspace_id=${who.id}`).toHaveLength(0)
      expect(
        await sql`select id from credit_ledger where workspace_id=${who.id} and type='consume'`,
      ).toHaveLength(0)
      expect(await getCreditBalance(db, who.id)).toMatchObject({
        available: 1000,
        held: 0,
        debt: 0,
      })
    } finally {
      await sql`delete from ai_model where key=${modelKey}`
    }
  })

  for (const stream of [false, true] as const) {
    for (const pricing of [
      {
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 4000, maxOutputTokens: 4900 },
      } as const,
      { mode: 'token', inputPer1k: 1, outputPer1k: 10 } as const,
    ]) {
      it(`${stream ? 'SSE' : 'JSON'} / ${pricing.mode} 返回兼容格式，按实际用量扣费并保存快照`, async () => {
        const who = await owner()
        const key = await textModel(pricing)
        const { sdk, mock, settled } = client(who.key.key, {
          config: defineTemplateConfig({
            app: config.app,
            auth: { oauth: [], turnstile: false },
            features: { publicApi: true },
            ai: { text: { reasoning: { display: true } } },
          }),
        })
        const response = await sdk.chat.completions.create({
          model: key,
          messages: [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hi' },
          ],
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        })
        let text = ''
        if (stream) {
          const chunks = []
          for await (const chunk of response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
            chunks.push(chunk)
            text += chunk.choices[0]?.delta.content ?? ''
          }
          expect(chunks.at(-1)?.usage).toMatchObject({
            prompt_tokens: 200,
            completion_tokens: 1180,
            total_tokens: 1380,
          })
          expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop')
          expect(JSON.stringify(chunks)).not.toMatch(/reasoning_content|Private reasoning/)
        } else {
          const completion = response as OpenAI.Chat.Completions.ChatCompletion
          text = completion.choices[0]?.message.content ?? ''
          expect(completion.usage).toMatchObject({ prompt_tokens: 200, completion_tokens: 1180 })
          expect(JSON.stringify(completion)).not.toMatch(/reasoning_content|Private reasoning/)
        }
        expect(text).toBe('Hello SDK')
        await settled()
        const charged = pricing.mode === 'per_call' ? 3 : 12
        expect(await getCreditBalance(db, who.id)).toMatchObject({
          available: 1000 - charged,
          held: 0,
          debt: 0,
        })
        const [message] =
          await sql`select pricing, credits, status from ai_message where workspace_id = ${who.id} and role = 'assistant'`
        expect(message).toMatchObject({ pricing, credits: charged, status: 'completed' })
        expect(JSON.stringify(mock.doStreamCalls[0]?.prompt)).toContain('Be helpful')
      })
    }
  }
  it('客户端取消 SSE 后继续读完模型并结算，不能通过断开连接逃避扣费', async () => {
    const who = await owner()
    const key = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 })
    const { apiDeps, settled } = client(who.key.key)
    const response = await handleCompletions(
      request(who.key.key, {
        model: key,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
      apiDeps,
    )
    await response.body?.cancel()
    await settled()
    expect(await getCreditBalance(db, who.id)).toMatchObject({ available: 988, held: 0 })
  })
  it('余额不足通过 SDK 以 OpenAI error 结构返回 402，且无预扣', async () => {
    const who = await owner(1)
    const key = await textModel({ mode: 'token', inputPer1k: 1000, outputPer1k: 1000 })
    const { sdk, mock } = client(who.key.key)
    await expect(
      sdk.chat.completions.create({ model: key, messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
      type: 'invalid_request_error',
    })
    expect(mock.doStreamCalls).toHaveLength(0)
    expect(await sql`select 1 from credit_hold where workspace_id = ${who.id}`).toHaveLength(0)
  })
  // 公开 API 文档（tasks.md 3.4）：文档中的示例请求体原样可用，避免文档与实现脱节
  for (const [locale, doc] of [
    ['en', enApiDoc],
    ['zh', zhApiDoc],
  ] as const) {
    it(`${locale} 文档中的示例请求体可直接调用并返回兼容格式`, async () => {
      const block = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1]
      if (!block) throw new Error('Missing JSON example in public API docs')
      const example = JSON.parse(block) as { model: string }
      expect(example.model).toBe('your-model-key')
      const who = await owner()
      const key = await textModel({ mode: 'token', inputPer1k: 1, outputPer1k: 10 })
      const { apiDeps, settled } = client(who.key.key)
      const response = await handleCompletions(
        request(who.key.key, { ...example, model: key }),
        apiDeps,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant' } }],
      })
      await settled()
    })
  }
})
