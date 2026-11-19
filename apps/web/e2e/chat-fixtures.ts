import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { fixtureDb } from './fixtures.ts'
import { chooseOption } from './select.ts'

// 对话页 e2e 的共用夹具（ai-chat.spec.ts、chat-ui.spec.ts）：测试模型、模拟 UI message 流与新建对话。

export const UUID = '[0-9a-f-]{36}'

export const slugOf = (page: Page) => new URL(page.url()).pathname.split('/')[2] ?? ''

/**
 * 打开对话列表并新建对话。模型列表经 KV 缓存（TTL 60 秒），项目也可能在没有可用模型时隐藏入口，
 * 因此刷新直到「New chat」出现（#373）。
 */
export async function newConversation(page: Page, slug: string) {
  const create = page.getByRole('button', { name: 'New chat' })
  await expect
    .poll(
      async () => {
        await page.goto(`/app/${slug}/chat`)
        return create.count()
      },
      { timeout: 90_000, intervals: [2_000, 5_000] },
    )
    .toBe(1)
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
  await create.click()
  await expect(page).toHaveURL(new RegExp(`/app/${slug}/chat/${UUID}$`))
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

/**
 * 让空间的权益包含一个按次计费的测试模型（模型标签写入套餐 features.models）。
 * Provider 默认 openai；离线 e2e 只为某个 Provider 配置了占位凭据的项目用 `E2E_CHAT_PROVIDER` 或参数改写（#373）。
 */
export async function seedChatModel(
  slug: string,
  { provider = process.env.E2E_CHAT_PROVIDER || 'openai' }: { provider?: string } = {},
) {
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
      values (${modelId},${tag},'text',${provider},'gpt-fixture',${sql.json(pricing)},${sql.json([tag])},-1000)`
  } finally {
    await sql.end()
  }
  return { modelId, key: tag }
}

export async function removeModel(modelId: string) {
  const sql = fixtureDb()
  try {
    await sql`update ai_model set enabled = false where id = ${modelId}`
  } finally {
    await sql.end()
  }
}

/** UI message 流（SSE）：start 事件带上 conversationId / messageId 元数据 */
export function uiStream(conversationId: string, messageId: string, deltas: string[]) {
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

export const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
}

/**
 * 选中刚写入的测试模型：模型列表经 KV 缓存（TTL 60 秒），刷新直到新模型出现在选择器中。
 * 选择器的可读名称不依赖语言时传 `name`（默认英文 "Model"）。
 */
export async function chooseSeededModel(page: Page, modelId: string) {
  await expect(async () => {
    await page.reload()
    const trigger = page.locator('[data-model-picker] [role="combobox"]')
    expect(await trigger.count()).toBe(1)
    await expect(async () => {
      if (!(await page.getByRole('listbox').isVisible())) await trigger.click({ timeout: 1_000 })
      await expect(page.getByRole('listbox')).toBeVisible({ timeout: 500 })
    }).toPass({ timeout: 10_000, intervals: [100, 250, 500] })
    expect(
      await page.locator(`[role="option"][data-value=${JSON.stringify(modelId)}]`).count(),
    ).toBe(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await chooseOption(trigger, { value: modelId })
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] })
}
