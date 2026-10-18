import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { getCreditBalance, grant } from '@product-res/credits'
import { aiModel, createDb, plan, planPrice, subscription } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { templateConfig } from '../../../src/server/template-config.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const databaseUrl = process.env.NODE_PRODUCTION_DATABASE_URL
const valkeyUrl = process.env.TEST_VALKEY_URL
if (!databaseUrl || !valkeyUrl) throw new Error('Missing production smoke resources')
const db = createDb(databaseUrl, { max: 3 })
const sql = db.$client
const secret = 'production-smoke-secret-at-least-32-characters'
const appUrl = 'https://product.ezarouter.cc'
const fixtureId = newId()
const modelId = newId()
const planId = newId()
const priceId = newId()
let userId: string
let slug: string
let cookie: string
let signOutCookie: string
let child: ChildProcess
let productionEnv: NodeJS.ProcessEnv
let base: string
let childExit: Promise<unknown[]>
let jobs: ChildProcess
let jobsExit: Promise<unknown[]>
let owners: string
let jobsBase: string
const logs: { event?: string; requestId?: string }[] = []
let upstreamCompleted = 0
let upstreamCanceled = 0
const upstream = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  expect(request.url).toBe('/v1/chat/completions')
  expect(request.headers.authorization).toBe('Bearer fixture-key')
  expect(request.headers['cf-aig-authorization']).toBeUndefined()
  expect(JSON.parse(body)).toMatchObject({ model: 'mock-model', stream: true })
  response.on('close', () => {
    if (!response.writableFinished) upstreamCanceled++
  })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
  emit({ choices: [{ index: 0, delta: { content: 'first ' } }] })
  // 保证客户端已断开、或 SIGTERM 已发出后才送最终 usage。
  await new Promise((resolve) => setTimeout(resolve, 1000))
  emit({ choices: [{ index: 0, delta: { content: 'last' } }] })
  emit({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 1000 },
  })
  response.end('data: [DONE]\n\n')
  upstreamCompleted++
})

beforeAll(async () => {
  const auth = createAuth({ APP_URL: appUrl, BETTER_AUTH_SECRET: secret }, db, {
    config: defineTemplateConfig({
      app: { name: 'Smoke', url: appUrl, supportEmail: 'hxl15380@gmail.com' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  })
  const signed = await auth.handler(
    new Request(`${appUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appUrl },
      body: JSON.stringify({
        email: `${fixtureId}@production-smoke.example`,
        password: 'correct-horse-battery-staple',
        name: 'Production smoke',
      }),
    }),
  )
  expect(signed.status).toBe(200)
  userId = ((await signed.json()) as { user: { id: string } }).user.id
  cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const secondSession = await auth.handler(
    new Request(`${appUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appUrl },
      body: JSON.stringify({
        email: `${fixtureId}@production-smoke.example`,
        password: 'correct-horse-battery-staple',
      }),
    }),
  )
  expect(secondSession.status).toBe(200)
  signOutCookie = secondSession.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const [workspace] = await sql<
    { slug: string }[]
  >`select slug from organization where id = ${userId}`
  if (!workspace) throw new Error('Missing fixture workspace')
  slug = workspace.slug
  await grant(db, { workspaceId: userId, source: 'admin', sourceRef: fixtureId, amount: 100 })
  await db.insert(aiModel).values({
    id: modelId,
    key: `production-${fixtureId}`,
    kind: 'text',
    provider: 'openai',
    providerModelId: 'mock-model',
    pricing: { mode: 'token', inputPer1k: 10, outputPer1k: 10 },
    paramsSchema: { 'x-text': { maxOutputTokens: 2000 } },
  })
  await db.insert(plan).values({
    id: planId,
    key: `production-${fixtureId}`,
    name: 'Smoke',
    type: 'subscription',
    credits: 0,
    features: { ...DEFAULT_FREE_FEATURES, models: [`production-${fixtureId}`] },
  })
  await db.insert(planPrice).values({
    id: priceId,
    planId,
    provider: 'stripe',
    providerPriceId: fixtureId,
    amount: 0,
    currency: 'USD',
    interval: 'month',
  })
  await db.insert(subscription).values({
    workspaceId: userId,
    planId,
    planPriceId: priceId,
    provider: 'stripe',
    providerSubscriptionId: fixtureId,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    lastEventAt: new Date(),
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as AddressInfo).port
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = (portProbe.address() as AddressInfo).port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  productionEnv = {
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
    BETTER_AUTH_SECRET: secret,
    APP_URL: appUrl,
    GOOGLE_CLIENT_ID: 'fixture',
    GOOGLE_CLIENT_SECRET: 'fixture',
    GITHUB_CLIENT_ID: 'fixture',
    GITHUB_CLIENT_SECRET: 'fixture',
    TURNSTILE_SITE_KEY: 'fixture',
    TURNSTILE_SECRET_KEY: 'fixture',
    CACHE_NAMESPACE: `production-${fixtureId}`,
    HOST: '127.0.0.1',
    PORT: String(port),
    SHUTDOWN_TIMEOUT_MS: '5000',
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    OPENAI_API_KEY: 'fixture-key',
  }
  const jobsPortProbe = createServer().listen(0, '127.0.0.1')
  await once(jobsPortProbe, 'listening')
  const jobsPort = (jobsPortProbe.address() as AddressInfo).port
  await new Promise<void>((resolve) => jobsPortProbe.close(() => resolve()))
  jobsBase = `http://127.0.0.1:${jobsPort}`
  owners = await mkdtemp(join(tmpdir(), 'web-jobs-production-'))
  jobs = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: fileURLToPath(new URL('../../../../jobs/', import.meta.url)),
    env: {
      ...productionEnv,
      PORT: String(jobsPort),
      JOB_EXECUTOR_ID: `web-smoke-${fixtureId}`,
      JOB_OWNERSHIP_DIRECTORY: owners,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  jobs.stdout?.resume()
  jobs.stderr?.resume()
  jobsExit = once(jobs, 'exit')
  await vi.waitFor(
    async () => {
      if (jobs.exitCode !== null) throw new Error('Production jobs exited before listen')
      expect(
        await fetch(`${jobsBase}/internal/live`).then(
          (res) => res.status,
          () => 0,
        ),
      ).toBe(200)
    },
    { timeout: 8000 },
  )
  productionEnv.JOBS_URL = jobsBase
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: root,
    env: productionEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logBuffer = ''
  child.stdout?.on('data', (chunk) => {
    logBuffer += String(chunk)
    const lines = logBuffer.split('\n')
    logBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('{')) logs.push(JSON.parse(line))
    }
  })
  child.stderr?.resume()
  childExit = once(child, 'exit')
  await vi.waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error('Production web exited before listen')
      const status = await fetch(`${base}/internal/live`).then(
        (res) => res.status,
        () => 0,
      )
      expect(status).toBe(200)
    },
    { timeout: 8000 },
  )
})

afterAll(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM')
    await childExit
  }
  if (jobs?.exitCode === null) {
    jobs.kill('SIGTERM')
    await jobsExit
  }
  if (owners) await rm(owners, { recursive: true, force: true })
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  if (userId) {
    await sql`delete from ai_message where workspace_id = ${userId}`
    await sql`delete from ai_conversation where workspace_id = ${userId}`
    await sql`delete from credit_hold_allocation where hold_id in (select id from credit_hold where workspace_id = ${userId})`
    await sql`delete from credit_ledger where workspace_id = ${userId}`
    await sql`delete from credit_hold where workspace_id = ${userId}`
    await sql`delete from credit_grant where workspace_id = ${userId}`
    await sql`delete from credit_debt where workspace_id = ${userId}`
    await sql`delete from subscription where workspace_id = ${userId}`
    await sql`delete from session where user_id = ${userId}`
    await sql`delete from account where user_id = ${userId}`
    await sql`delete from member where user_id = ${userId}`
    await sql`delete from organization where id = ${userId}`
    await sql`delete from "user" where id = ${userId}`
  }
  await sql`delete from ai_model where id = ${modelId}`
  await sql`delete from plan_price where id = ${priceId}`
  await sql`delete from plan where id = ${planId}`
  await db.close()
})

it('serves production SSR, Server Function RPC, static assets and no-DB prerender output', async () => {
  const live = await fetch(`${base}/internal/live`)
  expect(await live.json()).toMatchObject({ version: expect.stringMatching(/^[a-f0-9]{40}$/) })
  const ssr = await fetch(`${base}/login`)
  expect(ssr.status).toBe(200)
  expect(ssr.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/)
  const html = await ssr.text()
  await expect
    .poll(() =>
      logs.some(
        (line) =>
          line.event === 'http.request' && line.requestId === ssr.headers.get('x-request-id'),
      ),
    )
    .toBe(true)
  expect(html).toContain('</html>')
  const asset = html.match(/href="([^"]+\.css)"/)?.[1]
  expect(asset).toBeDefined()
  expect((await fetch(new URL(asset ?? '', base))).status).toBe(200)
  const files = await readdir(`${root}/.output/server/_ssr`)
  const originFile = files.find(
    (file) => file.startsWith('origin.functions-') && file.endsWith('.mjs'),
  )
  expect(originFile).toBeDefined()
  const source = await readFile(`${root}/.output/server/_ssr/${originFile}`, 'utf8')
  const id = source.match(/id: "([a-f0-9]+)",\s*name: "getSeoOrigin"/)?.[1]
  expect(id).toBeDefined()
  const rpc = await fetch(`${base}/_serverFn/${id}`, {
    headers: { 'x-tsr-serverFn': 'true', origin: base, 'sec-fetch-site': 'same-origin' },
  })
  expect(rpc.status).toBe(200)
  expect(await rpc.text()).toContain(appUrl)
  // 营销页关闭时没有可预渲染的公开首页
  if (templateConfig.marketing.enabled) {
    expect(await readFile(`${root}/.output/public/index.html`, 'utf8')).toContain('</html>')
    expect(await readFile(`${root}/.output/public/zh.html`, 'utf8')).toContain('</html>')
  }
})

it('passes native production requests to all auth endpoints without clone failures', async () => {
  const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })
  expect(session.status).toBe(200)
  const identity = (await session.json()) as { user?: { id?: string } } | null
  expect(identity?.user?.id).toBe(userId)
  // 不提供 token，让当前模板的防刷返回明确错误；不调用外部 Turnstile。
  for (const endpoint of ['sign-up/email', 'sign-in/email']) {
    const response = await fetch(`${base}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { origin: appUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${fixtureId}@production-smoke.example`,
        password: 'correct-horse-battery-staple',
        name: 'Production smoke',
      }),
    })
    if (templateConfig.auth.turnstile) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'TURNSTILE_FAILED' })
    } else {
      // 未启用 Turnstile：只验证原生请求被认证端点正常处理，没有请求体克隆失败
      expect(response.status).toBeLessThan(500)
    }
  }
  // 真实注销第二个会话，保留 AI 断连验收使用的原会话。
  const signOut = await fetch(`${base}/api/auth/sign-out`, {
    method: 'POST',
    headers: { cookie: signOutCookie, origin: appUrl, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(signOut.status).toBe(200)
  expect(await signOut.json()).toMatchObject({ success: true })
  const signedOut = await fetch(`${base}/api/auth/get-session?disableCookieCache=true`, {
    headers: { cookie: signOutCookie },
  })
  expect(signedOut.status).toBe(200)
  expect((await signedOut.json()) === null).toBe(true)
})

it('uses real jobs readiness and refuses media before any hold while files are unavailable', async () => {
  const jobsHealth = (await (await fetch(`${jobsBase}/internal/ready`)).json()) as {
    queue: { status: string }
    scheduler: { status: string; lastCronAt: string | null }
  }
  const response = await fetch(`${base}/api/health`)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({
    version: expect.stringMatching(/^[a-f0-9]{40}$/),
    db: { status: 'up' },
    cache: { status: 'up' },
    queue: jobsHealth.queue,
    scheduler: jobsHealth.scheduler,
  })
  const before =
    await sql`select count(*)::int as count from credit_hold where workspace_id = ${userId}`
  const media = await fetch(`${base}/api/ai/tasks`, {
    method: 'POST',
    headers: { cookie, origin: appUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ slug, modelId, params: {} }),
  })
  expect(media.status).toBe(503)
  expect(
    await sql`select count(*)::int as count from credit_hold where workspace_id = ${userId}`,
  ).toEqual(before)
  jobs.kill('SIGTERM')
  expect(await jobsExit).toEqual([0, null])
  const stopped = await fetch(`${base}/api/health`)
  expect(stopped.status).toBe(503)
  expect(await stopped.json()).toMatchObject({
    queue: { status: 'down' },
    scheduler: { status: 'down' },
    version: expect.stringMatching(/^[a-f0-9]{40}$/),
  })
})

for (const configuration of ['missing', 'occupied port']) {
  it(`fails production startup with ${configuration} without exposing configuration values`, () => {
    const result = spawnSync(process.execPath, ['.output/server/index.mjs'], {
      cwd: root,
      env: configuration === 'missing' ? {} : productionEnv,
      encoding: 'utf8',
      timeout: 8000,
    })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('node.web.start_failed')
    expect(result.stdout + result.stderr).not.toMatch(
      /postgres:\/\/|redis:\/\/|fixture-key|production-smoke-secret|EADDRINUSE/,
    )
  })
}

for (const terminate of [false, true]) {
  it(`settles full production usage after HTTP disconnect${terminate ? ' and SIGTERM' : ''}`, async () => {
    const response = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { cookie, origin: appUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug,
        modelId,
        message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      }),
    })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing chat stream')
    let streamed = ''
    await expect
      .poll(async () => {
        const { value } = await reader.read()
        streamed += new TextDecoder().decode(value)
        return streamed.includes('first ')
      })
      .toBe(true)
    const messageId = streamed.match(/"messageId":"([a-f0-9-]+)"/)?.[1]
    expect(messageId).toBeDefined()
    await reader.cancel()
    if (terminate) {
      child.kill('SIGTERM')
      expect(await childExit).toEqual([0, null])
    }
    await expect
      .poll(
        async () => {
          const [row] = await sql<
            { status: string }[]
          >`select status from ai_message where id = ${messageId as string}`
          return row?.status
        },
        { timeout: 5000 },
      )
      .toBe('completed')
    const [row] = await sql<
      {
        credits: number
        input_tokens: number
        output_tokens: number
        parts: unknown
        hold_id: string
      }[]
    >`select * from ai_message where id = ${messageId as string}`
    expect(row).toMatchObject({
      credits: 11,
      input_tokens: 100,
      output_tokens: 1000,
      parts: [{ type: 'text', text: 'first last' }],
    })
    const [reservation] =
      await sql`select status, captured_amount from credit_hold where id = ${row?.hold_id as string}`
    expect(reservation).toMatchObject({ status: 'captured', captured_amount: 11 })
    expect((await getCreditBalance(db, userId)).available).toBe(terminate ? 78 : 89)
    expect(upstreamCompleted).toBe(terminate ? 2 : 1)
    expect(upstreamCanceled).toBe(0)
  })
}
