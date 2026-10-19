import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { fixtureDb, login, register, simulateClientIp, uiText } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 对话列表与对话页（tasks.md 3.1）。本地没有真实模型：发送消息时拦截 POST /api/ai/chat，
// 返回模拟的 UI message 流或错误码；停止接口（p3-chat-edge 实现）同样在测试中拦截。

const UUID = '[0-9a-f-]{36}'

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
  }
})

const slugOf = (page: Page) => new URL(page.url()).pathname.split('/')[2] ?? ''

async function newConversation(page: Page, slug: string) {
  await page.goto(`/app/${slug}/chat`)
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page).toHaveURL(new RegExp(`/app/${slug}/chat/${UUID}$`))
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

test('creates, renames and archives own conversations', async ({ page }) => {
  const email = `chat-list-${randomUUID()}@example.com`
  await register(page, email)
  const slug = slugOf(page)
  await page.getByTestId('current-user').click()
  await page.locator(`a[href="/app/${slug}/chat"]`).click()
  await expect(page.getByText('No conversations yet.')).toBeVisible()

  const id = await newConversation(page, slug)
  await expect(page.getByTestId('conversation-title')).toHaveText('New chat')
  await page.getByRole('link', { name: 'All chats' }).click()

  const list = page.getByRole('region', { name: 'Conversations', exact: true })
  const row = list.getByRole('listitem', { name: 'New chat' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Rename' }).click()
  await list.getByLabel('Conversation title').fill('Trip planning')
  await list.getByRole('button', { name: 'Save' }).click()
  const renamed = list.getByRole('listitem', { name: 'Trip planning' })
  await expect(renamed).toBeVisible()

  await renamed.getByRole('button', { name: 'Archive' }).click()
  const archived = page.getByRole('region', { name: 'Archived conversations' })
  await expect(archived.getByRole('listitem', { name: 'Trip planning' })).toBeVisible()
  await expect(list.getByRole('listitem', { name: 'Trip planning' })).toHaveCount(0)

  const sql = fixtureDb()
  try {
    const [row] = await sql`select c.title, c.archived, u.email from ai_conversation c
      join "user" u on u.id = c.user_id where c.id = ${id}`
    expect(row).toMatchObject({ title: 'Trip planning', archived: true, email })
  } finally {
    await sql.end()
  }

  await archived.getByRole('button', { name: 'Unarchive' }).click()
  await expect(list.getByRole('listitem', { name: 'Trip planning' })).toBeVisible()
})

test('another member of the workspace gets 404 for a conversation', async ({ page }) => {
  const ownerEmail = `chat-owner-${randomUUID()}@example.com`
  const otherEmail = `chat-other-${randomUUID()}@example.com`
  await register(page, otherEmail, 'Other Member')
  await page.context().clearCookies()
  await register(page, ownerEmail)

  // 两人同属一个团队空间；对话由 owner 创建（团队空间可能因 tenancy 设置只读，直接写库）
  const sql = fixtureDb()
  const workspaceId = randomUUID()
  const slug = `chat-team-${randomUUID().slice(0, 8)}`
  const conversationId = newId()
  try {
    const [owner] = await sql`select id from "user" where email = ${ownerEmail}`
    const [other] = await sql`select id from "user" where email = ${otherEmail}`
    if (!owner || !other) throw new Error('Registered users missing from isolated database')
    await sql`insert into organization (id, name, slug, created_at, is_personal)
      values (${workspaceId}, 'Chat Team', ${slug}, now(), false)`
    await sql`insert into member (id, organization_id, user_id, role, created_at) values
      (${randomUUID()}, ${workspaceId}, ${owner.id}, 'owner', now()),
      (${randomUUID()}, ${workspaceId}, ${other.id}, 'admin', now())`
    await sql`insert into ai_conversation (id, workspace_id, user_id, title, model_key)
      values (${conversationId}, ${workspaceId}, ${owner.id}, 'Owner secrets', '')`
    await sql`insert into ai_message (id, workspace_id, conversation_id, role, parts) values
      (${newId()}, ${workspaceId}, ${conversationId}, 'user', ${sql.json([{ type: 'text', text: 'private question' }])})`

    await page.goto(`/app/${slug}/chat/${conversationId}`)
    await expect(page.getByTestId('conversation-title')).toHaveText('Owner secrets')
    await expect(page.getByText('private question')).toBeVisible()

    await page.context().clearCookies()
    await login(page, otherEmail)
    const response = await page.goto(`/app/${slug}/chat/${conversationId}`)
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Conversation not found' })).toBeVisible()
    await expect(page.getByText('private question')).toHaveCount(0)
    await page.goto(`/app/${slug}/chat`)
    await expect(page.getByText('No conversations yet.')).toBeVisible()
    await expect(page.getByText('Owner secrets')).toHaveCount(0)
  } finally {
    await sql`delete from ai_message where conversation_id = ${conversationId}`
    await sql`delete from ai_conversation where id = ${conversationId}`
    await sql`delete from member where organization_id = ${workspaceId}`
    await sql`delete from organization where id = ${workspaceId}`
    await sql.end()
  }
})

/** 让空间的权益包含一个按次计费的测试模型（模型标签写入套餐 features.models） */
async function seedChatModel(slug: string) {
  const sql = fixtureDb()
  const tag = `e2e-chat-${randomUUID().slice(0, 8)}`
  const modelId = newId()
  try {
    const [workspace] = await sql`select id from organization where slug = ${slug}`
    if (!workspace) throw new Error('Workspace fixture is missing')
    const planId = newId()
    const priceId = newId()
    const features = JSON.stringify({ ...DEFAULT_FREE_FEATURES, models: [tag] })
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${tag},'E2E chat','subscription',0,${features}::jsonb,1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values (${newId()},${workspace.id},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`
    const pricing = {
      mode: 'per_call',
      credits: 2,
      limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
    }
    await sql`insert into ai_model (id,key,kind,provider,provider_model_id,pricing,min_plan_features,sort)
      values (${modelId},${tag},'text','openai','gpt-fixture',${sql.json(pricing)},${sql.json([tag])},-1000)`
  } finally {
    await sql.end()
  }
  return { modelId, key: tag }
}

async function removeModel(modelId: string) {
  const sql = fixtureDb()
  try {
    await sql`update ai_model set enabled = false where id = ${modelId}`
  } finally {
    await sql.end()
  }
}

/** UI message 流（SSE）：start 事件带上 conversationId / messageId 元数据 */
function uiStream(conversationId: string, messageId: string, deltas: string[]) {
  const chunks = [
    { type: 'start', messageId, messageMetadata: { conversationId, messageId } },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}

test('chat page picks a model, streams replies, stops and explains errors', async ({ page }) => {
  test.setTimeout(150_000)
  await register(page, `chat-page-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  try {
    const conversationId = await newConversation(page, slug)
    // 模型列表经 KV 缓存（TTL 60 秒）：刷新直到新模型出现在选择器中
    await expect
      .poll(
        async () => {
          await page.reload()
          return page.getByLabel('Model').locator(`option[value="${model.modelId}"]`).count()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe(1)
    await page.getByLabel('Model').selectOption(model.modelId)
    await expect(page.getByTestId('credit-estimate')).toHaveText(/2 credits/)

    // 1. 正常回复：只提交本轮用户消息，逐段渲染模拟流
    const messageId = newId()
    const bodies: unknown[] = []
    await page.route('**/api/ai/chat', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({
        status: 200,
        headers: { ...STREAM_HEADERS, 'x-conversation-id': conversationId },
        body: uiStream(conversationId, messageId, ['Hello', ' from', ' the model']),
      })
    })
    const message = page.getByLabel('Message', { exact: true })
    await message.fill('Plan a weekend trip')
    await page.getByRole('button', { name: 'Send' }).click()
    const messages = page.getByRole('list', { name: 'Messages' })
    await expect(messages.getByRole('listitem', { name: 'You' })).toHaveText(/Plan a weekend trip/)
    await expect(messages.getByRole('listitem', { name: 'Assistant' })).toHaveText(
      /Hello from the model/,
    )
    expect(bodies).toEqual([
      {
        slug,
        modelId: model.modelId,
        conversationId,
        message: { role: 'user', parts: [{ type: 'text', text: 'Plan a weekend trip' }] },
      },
    ])
    // 首轮完成后对话以首条消息命名
    await expect(page.getByTestId('conversation-title')).toHaveText('Plan a weekend trip')

    await message.fill('And the budget?')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(messages.getByRole('listitem', { name: 'You' })).toHaveCount(2)
    expect(bodies.at(-1)).toMatchObject({
      message: { role: 'user', parts: [{ type: 'text', text: 'And the budget?' }] },
    })
    await page.unroute('**/api/ai/chat')

    // 2. 错误码显示为可读提示
    for (const [status, code, text, billing] of [
      [503, 'AI_PROVIDER_NOT_CONFIGURED', uiText('chat_error_ai_provider_not_configured'), 0],
      [402, 'INSUFFICIENT_CREDITS', uiText('chat_error_insufficient_credits'), 1],
      [429, 'RATE_LIMITED', uiText('chat_error_rate_limited'), 0],
    ] as const) {
      await page.route('**/api/ai/chat', (route) =>
        route.fulfill({ status, json: { error: { code, message: code } } }),
      )
      await message.fill(`Trigger ${code}`)
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.getByRole('alert')).toContainText(text)
      await expect(page.getByRole('link', { name: 'Go to billing' })).toHaveCount(billing)
      await page.unroute('**/api/ai/chat')
    }
  } finally {
    await removeModel(model.modelId)
  }
})

test('stop button calls the stop endpoint with the streaming message id', async ({ page }) => {
  test.setTimeout(150_000)
  await register(page, `chat-stop-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  const messageIds = [newId(), newId(), newId()]
  try {
    // 模拟一条不会自行结束的流：发出 start 与第一段文本后保持打开，直到请求被中止；
    // 第三条只发 start（模拟上游首个输出前），此时 useChat 仍为 submitted
    await page.addInitScript(
      ({ messageIds }) => {
        const original = window.fetch
        let calls = 0
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (!url.endsWith('/api/ai/chat')) return original(input, init)
          const encoder = new TextEncoder()
          const send = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
          const body = JSON.parse(String(init?.body)) as { conversationId: string }
          const call = calls++
          const messageId = messageIds[call % messageIds.length]
          const stream = new ReadableStream({
            start(controller) {
              const metadata = { conversationId: body.conversationId, messageId }
              controller.enqueue(send({ type: 'start', messageId, messageMetadata: metadata }))
              if (call < 2) {
                controller.enqueue(send({ type: 'start-step' }))
                controller.enqueue(send({ type: 'text-start', id: 't1' }))
                controller.enqueue(send({ type: 'text-delta', id: 't1', delta: 'Partial answer' }))
              }
              init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('Aborted', 'AbortError')),
              )
            },
          })
          return Promise.resolve(
            new Response(stream, {
              headers: {
                'content-type': 'text/event-stream',
                'x-vercel-ai-ui-message-stream': 'v1',
              },
            }),
          )
        }
      },
      { messageIds },
    )
    // 第一条回复停止成功；第二条在停止前已因出错结束，接口幂等返回 failed
    const stopRequests: { path: string; body: unknown }[] = []
    await page.route('**/api/ai/chat/*/stop', async (route) => {
      const request = route.request()
      stopRequests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
      await route.fulfill({
        status: 200,
        json: { status: stopRequests.length === 2 ? 'failed' : 'aborted' },
      })
    })

    await newConversation(page, slug)
    await expect
      .poll(
        async () => {
          await page.reload()
          return page.getByLabel('Model').locator(`option[value="${model.modelId}"]`).count()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe(1)
    await page.getByLabel('Model').selectOption(model.modelId)
    await page.getByLabel('Message', { exact: true }).fill('Write a long story')
    await page.getByRole('button', { name: 'Send' }).click()
    const replies = page.getByRole('list', { name: 'Messages' }).getByRole('listitem', {
      name: 'Assistant',
    })
    await expect(replies.first()).toContainText('Partial answer')

    await page.getByRole('button', { name: 'Stop' }).click()
    await expect
      .poll(() => stopRequests)
      .toEqual([{ path: `/api/ai/chat/${messageIds[0]}/stop`, body: { slug } }])
    await expect(replies.first()).toContainText('Stopped')
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)

    await page.getByLabel('Message', { exact: true }).fill('Try again')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(replies.nth(1)).toContainText('Partial answer')
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(replies.nth(1)).toContainText('This reply failed.')
    expect(stopRequests[1]).toEqual({ path: `/api/ai/chat/${messageIds[1]}/stop`, body: { slug } })
    await expect(replies.nth(1)).not.toContainText('Stopped')

    // 首个输出前停止也必须通知服务端，不能只中断本地读取
    await page.getByLabel('Message', { exact: true }).fill('Stop before output')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(replies).toHaveCount(3)
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect.poll(() => stopRequests).toHaveLength(3)
    expect(stopRequests[2]).toEqual({ path: `/api/ai/chat/${messageIds[2]}/stop`, body: { slug } })
    await expect(replies.nth(2)).toContainText('Stopped')
  } finally {
    await removeModel(model.modelId)
  }
})
