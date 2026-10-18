import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { getCreditBalance, grant, hold } from '@product-res/credits'
import {
  type AiPricingJson,
  type AiUsageCheckpoint,
  aiConversation,
  aiMessage,
  createDb,
  member,
  organization,
  user,
} from '@product-res/db'
import { afterAll, expect, it, vi } from 'vitest'
import { BILLING_RETRY_CRON } from '../src/billing.ts'
import worker from '../src/index.ts'

// tasks.md 2.6：jobs 启动时注册的 `ai_message` 兜底处理器，经 BILLING_RETRY_CRON 的 hold sweep
// 结算超时未结算的对话预扣：有正文按检查点，无正文（包括仅 reasoning）全额释放。

const db = createDb(env.HYPERDRIVE)
const sql = db.$client
const id = () => crypto.randomUUID()
const workspaces: string[] = []

/** 一个有余额的空间，以及一条已超时（预扣过期）、仍为 streaming 的回复 */
async function staleReply(options: {
  pricing: AiPricingJson
  holdAmount: number
  inputTokens: number
  checkpoint?: AiUsageCheckpoint
  text?: string
}) {
  const ws = id()
  workspaces.push(ws)
  await db.insert(user).values({ id: ws, name: 'Sweep', email: `${ws}@ai-sweep.example.test` })
  await db.insert(organization).values({ id: ws, name: 'Sweep', slug: ws })
  await db.insert(member).values({ id: id(), userId: ws, organizationId: ws, role: 'owner' })
  await grant(db, { workspaceId: ws, source: 'admin', sourceRef: id(), amount: 1000 })
  const messageId = id()
  const reservation = await hold(db, {
    workspaceId: ws,
    userId: ws,
    amount: options.holdAmount,
    refType: 'ai_message',
    refId: messageId,
    expiresAt: new Date(Date.now() - 60_000),
  })
  const conversationId = id()
  await db
    .insert(aiConversation)
    .values({ id: conversationId, workspaceId: ws, userId: ws, title: 'sweep', modelKey: 'sweep' })
  await db.insert(aiMessage).values({
    id: messageId,
    conversationId,
    workspaceId: ws,
    role: 'assistant',
    parts: options.text ? [{ type: 'text', text: options.text }] : [],
    pricing: options.pricing,
    status: 'streaming',
    inputTokens: options.inputTokens,
    usageCheckpoint: options.checkpoint ?? null,
    holdId: reservation.id,
  })
  return { ws, messageId, holdId: reservation.id }
}

async function state(reply: { ws: string; messageId: string; holdId: string }) {
  const [message] = await sql<{ status: string; parts: unknown[]; credits: number | null }[]>`
    select status, parts, credits from ai_message where id = ${reply.messageId}`
  const [reservation] = await sql<{ status: string; captured_amount: number }[]>`
    select status, captured_amount from credit_hold where id = ${reply.holdId}`
  return { message, hold: reservation, balance: await getCreditBalance(db, reply.ws) }
}

afterAll(async () => {
  // audit_log 对 app 只追加，审计行由 migrator 清理
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR).$client
  for (const ws of workspaces) {
    await sql`delete from ai_message where workspace_id = ${ws}`
    await sql`delete from ai_conversation where workspace_id = ${ws}`
    await migrator`delete from audit_log where workspace_id = ${ws}`
    await sql`delete from credit_hold_allocation where hold_id in
      (select id from credit_hold where workspace_id = ${ws})`
    await sql`delete from credit_ledger where workspace_id = ${ws}`
    await sql`delete from credit_hold where workspace_id = ${ws}`
    await sql`delete from credit_grant where workspace_id = ${ws}`
    await sql`delete from credit_debt where workspace_id = ${ws}`
    await sql`delete from member where organization_id = ${ws}`
    await sql`delete from organization where id = ${ws}`
    await sql`delete from "user" where id = ${ws}`
  }
})

it('BILLING_RETRY_CRON 的 hold sweep 找到 ai_message 处理器，按正文检查点收费，无正文或仅 reasoning 全退', async () => {
  const token: AiPricingJson = { mode: 'token', inputPer1k: 10, outputPer1k: 100, minCharge: 2 }
  // 按 token 有检查点：ceil((50 × 10 + 300 × 100) / 1000) = 31
  const withCheckpoint = await staleReply({
    pricing: token,
    holdAmount: 101,
    inputTokens: 50,
    checkpoint: { inputTokens: 50, outputTokens: 300, at: new Date().toISOString() },
    text: 'partial reply',
  })
  // 按 token 无检查点且无正文：不收 minCharge，全额释放
  const noCheckpoint = await staleReply({ pricing: token, holdAmount: 101, inputTokens: 50 })
  const reasoningOnly = await staleReply({
    pricing: token,
    holdAmount: 101,
    inputTokens: 50,
    checkpoint: {
      inputTokens: 50,
      outputTokens: 300,
      reasoningTokens: 300,
      at: new Date().toISOString(),
    },
  })
  // 按次无输出：释放
  const perCall = await staleReply({
    pricing: {
      mode: 'per_call',
      credits: 3,
      limits: { maxInputTokens: 1000, maxOutputTokens: 500 },
    },
    holdAmount: 3,
    inputTokens: 20,
  })

  // 同一次 Cron 中的其他任务在测试环境可能失败（缺少支付配置），不影响 hold sweep
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await worker
    .scheduled(createScheduledController({ cron: BILLING_RETRY_CRON }), env)
    .catch(() => {})
  vi.restoreAllMocks()

  const failures = await sql<{ target_id: string }[]>`
    select target_id from audit_log where action = 'billing.cron.hold_sweep.failed'
      and workspace_id in ${sql(workspaces)}`
  expect(failures).toEqual([])

  expect(await state(withCheckpoint)).toMatchObject({
    message: { status: 'failed', parts: [{ type: 'text', text: 'partial reply' }], credits: 31 },
    hold: { status: 'captured', captured_amount: 31 },
    balance: { available: 969, held: 0 },
  })
  expect(await state(noCheckpoint)).toMatchObject({
    message: { status: 'failed', parts: [], credits: 0 },
    hold: { status: 'released', captured_amount: 0 },
    balance: { available: 1000, held: 0 },
  })
  expect(await state(reasoningOnly)).toMatchObject({
    message: { status: 'failed', parts: [], credits: 0 },
    hold: { status: 'released', captured_amount: 0 },
    balance: { available: 1000, held: 0 },
  })
  expect(await state(perCall)).toMatchObject({
    message: { status: 'failed', parts: [], credits: 0 },
    hold: { status: 'released' },
    balance: { available: 1000, held: 0 },
  })
})
