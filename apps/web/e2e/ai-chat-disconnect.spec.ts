import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { actualCredits, chatHoldSweeper, messageText, type Pricing } from '@product-res/ai'
import type { HoldSweepHandler } from '@product-res/billing'
import { getCreditBalance, grant, reconcileWorkspaceCredits } from '@product-res/credits'
import { creditHold, type Database } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import templateConfig from '../../../template.config.ts'
import { FINAL_USAGE, LONG_TAIL, PREFIX, SHORT_TAIL } from './ai-chat-disconnect.model.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// tasks 2.7：实际 POST 路由 + waitUntil + DB 结算，仅模型工厂由测试 Vite 配置替换。
// Miniflare 不会复现平台 30 秒静默取消：长流挂起后直接运行 DB-only 回收器。
const PRICING: Pricing = { mode: 'token', inputPer1k: 10, outputPer1k: 20, minCharge: 1 }
const PROMPT = 'Write a story'

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

async function prepare(page: Page, kind: 'short' | 'long') {
  await register(page, `disconnect-${randomUUID()}@example.com`)
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const sql = fixtureDb()
  const db = drizzle(fixtureDb()) as Database
  const modelId = newId()
  const tag = `disconnect-${newId()}`
  try {
    const [workspace] = await sql<
      { id: string }[]
    >`select id from organization where slug = ${slug}`
    if (!workspace) throw new Error('Isolated workspace missing')
    // 原始查询使用独立客户端，避免 Drizzle 的 JSON 解析器影响测试断言。
    await grant(db, {
      workspaceId: workspace.id,
      source: 'admin',
      sourceRef: tag,
      amount: 100,
    })
    const initial = await getCreditBalance(db, workspace.id)
    const planId = newId()
    const priceId = newId()
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${tag},'Disconnect fixture','subscription',0,
        ${sql.json({ ...DEFAULT_FREE_FEATURES, models: [tag] })},1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,last_event_at)
      values (${newId()},${workspace.id},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`
    await sql`insert into ai_model (id,key,kind,provider,provider_model_id,pricing,params_schema,min_plan_features,sort)
      values (${modelId},${tag},'text','mock',${`disconnect-${kind}`},${sql.json(PRICING)},
        ${sql.json({ 'x-text': { maxOutputTokens: 1000 } })},${sql.json([tag])},-1000)`
    await page.goto(`/app/${slug}/chat`)
    await page.getByRole('button', { name: 'New chat' }).click()
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
    const conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    await expect
      .poll(
        async () => {
          await page.reload()
          return page.getByLabel('Model').locator(`option[value="${modelId}"]`).count()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe(1)
    await page.getByLabel('Model').selectOption(modelId)
    return { slug, sql, db, workspaceId: workspace.id, modelId, conversationId, initial }
  } catch (error) {
    await db.$client.end()
    await sql.end()
    throw error
  }
}

type Fixture = Awaited<ReturnType<typeof prepare>>

async function assistant(f: Fixture) {
  const [row] =
    await f.sql`select * from ai_message where conversation_id = ${f.conversationId} and role = 'assistant'`
  if (!row) throw new Error('Assistant message missing')
  return row
}

async function sendAndClose(page: Page, f: Fixture) {
  await page.getByLabel('Message', { exact: true }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('listitem', { name: 'Assistant', exact: true })).toContainText(
    PREFIX,
    { timeout: 30_000 },
  )
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect
    .poll(async () => (await assistant(f)).usage_checkpoint?.outputTokens)
    .toBe(PREFIX.length)
  await page.close()
  return Date.now()
}

async function assertAccounting(page: Page, f: Fixture, messageId: string, charge: number) {
  const ledger = await f.sql`select type, delta from credit_ledger
    where workspace_id = ${f.workspaceId} and ref_type = 'ai_message' and ref_id = ${messageId}`
  expect(ledger).toEqual([{ type: 'consume', delta: -charge }])
  expect(await getCreditBalance(f.db, f.workspaceId)).toMatchObject({
    available: f.initial.available - charge,
    held: 0,
    debt: 0,
  })
  expect(await reconcileWorkspaceCredits(f.db, f.workspaceId)).toMatchObject({
    consistent: true,
    difference: 0,
    held: 0,
    debt: 0,
  })
  await page.goto(`/app/${f.slug}/usage`)
  const row = page.getByRole('row').filter({ hasText: messageId })
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('cell').nth(1)).toHaveText('consume')
  await expect(row.getByRole('cell').nth(2)).toHaveText(String(-charge))
}

test('closing a page preserves the full short reply and settles final usage', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000)
  const f = await prepare(page, 'short')
  try {
    const closedAt = await sendAndClose(page, f)
    await expect
      .poll(async () => (await assistant(f)).status, { timeout: 25_000 })
      .toBe('completed')
    expect(Date.now() - closedAt).toBeLessThan(30_000)
    const saved = await assistant(f)
    expect(saved).toMatchObject({
      input_tokens: FINAL_USAGE.input,
      output_tokens: FINAL_USAGE.output,
    })
    expect(saved.usage_checkpoint.outputTokens).not.toBe(FINAL_USAGE.output)
    const reopened = await context.newPage()
    await reopened.goto(`/app/${f.slug}/chat/${f.conversationId}`)
    const reply = reopened.getByRole('listitem', { name: 'Assistant', exact: true })
    await expect(reply).toContainText(PREFIX + SHORT_TAIL)
    await expect(reply).not.toContainText('Incomplete')
    await expect(reply).not.toContainText('This reply failed.')
    await assertAccounting(
      reopened,
      f,
      saved.id,
      actualCredits(PRICING, {
        inputTokens: FINAL_USAGE.input,
        outputTokens: FINAL_USAGE.output,
      }),
    )
  } finally {
    await f.sql`update ai_model set enabled = false where id = ${f.modelId}`
    await f.db.$client.end()
    await f.sql.end()
  }
})

test('a disconnected long reply remains visible and the sweeper settles its checkpoint once', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  const f = await prepare(page, 'long')
  const sweeper: HoldSweepHandler = chatHoldSweeper({ overage: templateConfig.billing.overage })
  try {
    const closedAt = await sendAndClose(page, f)
    // 超过断开后 30 秒，模型仍不结束；不走 stop / error，避免用主动中断冒充静默取消。
    await new Promise((resolve) => setTimeout(resolve, 31_000))
    expect(Date.now() - closedAt).toBeGreaterThan(30_000)
    const pending = await assistant(f)
    expect(pending.status).toBe('streaming')
    expect(messageText(pending.parts)).toBe(PREFIX + LONG_TAIL)
    expect(pending.usage_checkpoint).toMatchObject({
      inputTokens: PROMPT.length + 8,
      outputTokens: (PREFIX + LONG_TAIL).length,
    })
    const reopened = await context.newPage()
    await reopened.goto(`/app/${f.slug}/chat/${f.conversationId}`)
    const reply = reopened.getByRole('listitem', { name: 'Assistant', exact: true })
    await expect(reply).toContainText(PREFIX + LONG_TAIL)
    await expect(reply).toContainText('Incomplete')
    const [reservation] = await f.db
      .select()
      .from(creditHold)
      .where(eq(creditHold.id, pending.hold_id))
    expect(reservation?.status).toBe('held')
    if (!reservation?.expiresAt) throw new Error('Expiring chat reservation missing')
    const sweepAt = new Date(reservation.expiresAt.getTime() + 1)
    // 仅触发本条预扣的真实兜底处理器；全库时钟快进会提前回收其他夹具的 hold。
    const recover = () =>
      f.db.transaction((tx) =>
        sweeper({
          db: f.db,
          tx,
          hold: reservation,
          now: sweepAt,
        }),
      )
    await recover()
    await expect(recover()).rejects.toMatchObject({ code: 'HOLD_NOT_ACTIVE' })
    const saved = await assistant(f)
    expect(saved.status).toBe('failed')
    expect(messageText(saved.parts)).toBe(PREFIX + LONG_TAIL)
    await reopened.reload()
    await expect(reply).toContainText(PREFIX + LONG_TAIL)
    await expect(reply).toContainText('This reply failed.')
    const charge = actualCredits(PRICING, pending.usage_checkpoint)
    expect(charge).toBeGreaterThan(
      actualCredits(PRICING, { inputTokens: PROMPT.length + 8, outputTokens: 0 }),
    )
    await assertAccounting(reopened, f, saved.id, charge)
  } finally {
    await f.sql`update ai_model set enabled = false where id = ${f.modelId}`
    await f.db.$client.end()
    await f.sql.end()
  }
})
