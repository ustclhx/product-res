import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import { newId } from '@product-res/shared'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { METRICS_DAILY_CRON, summarizeDailyMetrics } from '../src/cron/metrics-daily.ts'
import worker from '../src/index.ts'

const db = createDb(env.HYPERDRIVE)
const day = '2001-02-03'
const at = '2001-02-03T12:00:00Z'
const next = '2001-02-04T00:00:00Z'
const old = '2001-02-01T00:00:00Z'
const users = [newId(), newId(), newId()]
const spaces = [newId(), newId(), newId(), newId()]
const planId = newId()
const prices = [newId(), newId(), newId()]
const conversationId = newId()
const messages = Array.from({ length: 6 }, newId)
const holds = [newId(), newId()]

beforeAll(async () => {
  const sql = db.$client
  for (const [index, id] of users.entries())
    await sql`insert into "user" (id,name,email,created_at) values (${id},'Metrics',${`${id}@metrics.test`},${index === 0 ? old : index === 1 ? at : next})`
  for (const id of spaces)
    await sql`insert into organization (id,name,slug,created_at) values (${id},'Metrics',${id},${old})`
  await sql`insert into plan (id,key,name,type,credits,features) values (${planId},${planId},'Metrics','subscription',100,'{}')`
  for (const [index, id] of prices.entries())
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency) values (${id},${planId},'stripe',${id},${index === 1 ? 'year' : 'month'},${index === 1 ? 12000 : 1200},${index === 2 ? 'EUR' : 'USD'})`
  // 第一个空间两份有效重叠订阅：MRR 都计入，付费空间只计一次；trialing 排除。
  for (const [index, priceId] of [prices[0], prices[1], prices[2], prices[0]].entries())
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,cancel_at_period_end,current_period_start,current_period_end,last_event_at,created_at)
    values (${newId()},${spaces[index < 2 ? 0 : index - 1] ?? ''},${planId},${priceId ?? ''},'stripe',${newId()},${index === 3 ? 'trialing' : index === 0 ? 'canceled' : 'active'},${index === 0},${old},'2001-03-01',${at},${old})`
  await sql`insert into ai_conversation (id,workspace_id,user_id,model_key) values (${conversationId},${spaces[0] ?? ''},${users[0] ?? ''},'model-a')`
  for (const [index, id] of holds.entries())
    await sql`insert into credit_hold (id,workspace_id,user_id,amount,status,ref_type,ref_id,overage_absorbed,updated_at) values (${id},${spaces[0] ?? ''},${users[0] ?? ''},100,'captured','ai_message',${messages[index] ?? ''},${index === 0 ? 3 : 7},${at})`
  for (const [index, id] of messages.entries())
    await sql`insert into ai_message (id,conversation_id,workspace_id,role,model_key,status,hold_id,updated_at) values (${id},${conversationId},${spaces[0] ?? ''},${index === 4 ? 'user' : 'assistant'},${index === 1 ? 'model-b' : 'model-a'},${index === 2 ? 'failed' : index === 3 ? 'aborted' : index === 5 ? 'streaming' : 'completed'},${holds[index] ?? null},${at})`
  for (const [type, delta, createdAt] of [
    ['consume', -100, at],
    ['consume', -50, at],
    ['expire', -40, at],
    ['consume', -900, next],
  ] as const)
    await sql`insert into credit_ledger (id,workspace_id,type,delta,created_at) values (${newId()},${spaces[0] ?? ''},${type},${delta},${createdAt})`
})
afterAll(async () => {
  const sql = createDb(env.HYPERDRIVE_MIGRATOR).$client
  await sql`delete from metrics_daily where day=${day}`
  await sql`delete from ai_message where conversation_id=${conversationId}`
  await sql`delete from ai_conversation where id=${conversationId}`
  await sql`delete from credit_hold where workspace_id in ${sql(spaces)}`
  await sql`delete from credit_ledger where workspace_id in ${sql(spaces)}`
  await sql`delete from subscription where workspace_id in ${sql(spaces)}`
  await sql`delete from plan_price where plan_id=${planId}`
  await sql`delete from plan where id=${planId}`
  await sql`delete from organization where id in ${sql(spaces)}`
  await sql`delete from "user" where id in ${sql(users)}`
})
it('固定种子按 UTC 边界、月化价格、去重空间与结算时间汇总，Cron 覆盖同一天', async () => {
  const result = await summarizeDailyMetrics(db, day)
  expect(result).toMatchObject({
    registrations: 1,
    total_users: 2,
    total_workspaces: 4,
    paid_workspaces: 2,
    mrr_by_currency: { USD: 2200, EUR: 1200 },
    credits_consumed: 150,
    overage_absorbed: 10,
    overage_by_model: { 'model-a': 3, 'model-b': 7 },
    text_completed: 2,
    text_failed: 1,
    text_aborted: 1,
    media_succeeded: null,
    media_failed: null,
  })
  expect(new Date(String(result?.data_through)).toISOString()).toBe('2001-02-04T00:00:00.000Z')
  await db.$client`update metrics_daily set credits_consumed=999 where day=${day}`
  await worker.scheduled(
    createScheduledController({
      cron: METRICS_DAILY_CRON,
      scheduledTime: Date.parse(`${next}`) + 15 * 60000,
    }),
    env,
  )
  const rows = await db.$client`select * from metrics_daily where day=${day}`
  expect(rows).toHaveLength(1)
  expect(rows[0]?.credits_consumed).toBe(150)
})
