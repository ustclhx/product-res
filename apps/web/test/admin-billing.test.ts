import { getCreditBalance, reconcileWorkspaceCredits } from '@product-res/credits'
import { newId } from '@product-res/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { runAdminAction } from '../src/features/admin/action.ts'
import { adjustAdminCredits, creditAdjustmentInput } from '../src/features/admin/credits.ts'
import {
  listAdminPayments,
  listAdminPurchases,
  listAdminRefunds,
  listAdminSubscriptions,
  listAdminWebhooks,
} from '../src/features/billing/admin-data.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const adminId = newId()
const spaces = [newId(), newId()]
const plans: string[] = []
const webhookIds: string[] = []
const context = { db, admin: { id: adminId }, ip: '203.0.113.7' }
let initialized = false
async function fixture() {
  if (initialized) return
  await db.$client`insert into "user"(id,name,email,role) values(${adminId},'Admin',${`${adminId}@admin-billing.example`},'admin')`
  for (const ws of spaces) {
    await db.$client`insert into organization(id,name,slug) values(${ws},'Admin billing',${ws})`
    const plan = newId(),
      price = newId(),
      order = newId(),
      paid = newId(),
      sub = newId()
    plans.push(plan)
    await db.$client`insert into plan(id,key,name,type,credits,features) values(${plan},${plan},'Fixture','credit_pack',100,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":false}'::jsonb)`
    await db.$client`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${price},${plan},'stripe',${price},1234,'USD')`
    await db.$client`insert into purchase(id,workspace_id,user_id,plan_id,plan_price_id,provider,provider_order_id,status,amount,currency) values(${order},${ws},${adminId},${plan},${price},'stripe',${order},'paid',1234,'USD')`
    await db.$client`insert into payment(id,workspace_id,provider,provider_payment_id,purchase_id,kind,amount,currency,paid_at) values(${paid},${ws},'stripe',${paid},${order},'one_time',1234,'USD',now())`
    await db.$client`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,last_event_at) values(${sub},${ws},${plan},${price},'stripe',${sub},'active',now())`
    await db.$client`insert into refund_request(id,workspace_id,user_id,payment_id,reason) values(${newId()},${ws},${adminId},${paid},'Fixture refund')`
    const payloads = [
      { provider: 'stripe', payload: { data: { object: { metadata: { workspaceId: ws } } } } },
      { provider: 'stripe', payload: { data: { object: { payment_intent: paid } } } },
      { provider: 'stripe', payload: { data: { object: { id: sub } } } },
      { provider: 'stripe', payload: { data: { object: { id: order } } } },
      {
        provider: 'paypal',
        payload: { resource: { custom_id: JSON.stringify([1, ws, price, adminId]) } },
      },
    ]
    for (const item of payloads) {
      const id = newId()
      webhookIds.push(id)
      await db.$client`insert into webhook_event(id,provider,provider_event_id,type,payload,status) values(${id},${item.provider},${id},'fixture',${JSON.stringify(item.payload)}::jsonb,'failed')`
    }
  }
  const unknown = newId()
  webhookIds.push(unknown)
  await db.$client`insert into webhook_event(id,provider,provider_event_id,type,payload) values(${unknown},'stripe',${unknown},'unknown','{}'::jsonb)`
  initialized = true
}

afterAll(async () => {
  await migrator.$client`delete from audit_log where actor_user_id=${adminId}`
  await db.$client`delete from credit_ledger where workspace_id in ${db.$client(spaces)}`
  await db.$client`delete from credit_grant where workspace_id in ${db.$client(spaces)}`
  await db.$client`delete from refund_request where workspace_id in ${db.$client(spaces)}`
  await db.$client`delete from payment where workspace_id in ${db.$client(spaces)}`
  await db.$client`delete from purchase where workspace_id in ${db.$client(spaces)}`
  await db.$client`delete from subscription where workspace_id in ${db.$client(spaces)}`
  if (plans.length) {
    await db.$client`delete from plan_price where plan_id in ${db.$client(plans)}`
    await db.$client`delete from plan where id in ${db.$client(plans)}`
  }
  if (webhookIds.length)
    await db.$client`delete from webhook_event where id in ${db.$client(webhookIds)}`
  await db.$client`delete from organization where id in ${db.$client(spaces)}`
  await db.$client`delete from "user" where id=${adminId}`
  await Promise.all([db.$client.end(), migrator.$client.end()])
})

describe('后台积分调整与账务列表', () => {
  it('并发重复提交只发放一次，原始审计含数量、过期时间、原因与管理员', async () => {
    await fixture()
    const workspaceId = spaces[0] as string
    const input = creditAdjustmentInput.parse({
      kind: 'grant',
      adjustmentId: newId(),
      workspaceId,
      amount: 100,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      reason: '服务补偿',
    })
    const results = await Promise.all(
      [0, 1].map(() =>
        runAdminAction(context, 'credits.adjust', (scope) => adjustAdminCredits(scope, input)),
      ),
    )
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect(await getCreditBalance(db, workspaceId)).toEqual({ available: 100, held: 0, debt: 0 })
    const rows =
      await db.$client`select source_ref,amount,expires_at from credit_grant where workspace_id=${workspaceId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source_ref: input.adjustmentId, amount: 100 })
    const audits =
      await db.$client`select actor_user_id,ip,meta from audit_log where target_id=${input.adjustmentId} and action='credits.adjust'`
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor_user_id: adminId, ip: context.ip, meta: { input } })
    await expect(
      runAdminAction(context, 'credits.adjust', (scope) =>
        adjustAdminCredits(scope, { ...input, workspaceId: spaces[1] as string }),
      ),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_ID_CONFLICT' })
    expect(await reconcileWorkspaceCredits(db, workspaceId)).toMatchObject({ consistent: true })
  })

  it('收回指定批次重复调整一次生效，并保留余额与对账不变式', async () => {
    await fixture()
    const workspaceId = spaces[1] as string
    const input = creditAdjustmentInput.parse({
      kind: 'grant',
      adjustmentId: newId(),
      workspaceId,
      amount: 20,
      expiresAt: null,
      reason: '测试补偿',
    })
    await runAdminAction(context, 'credits.adjust', (scope) => adjustAdminCredits(scope, input))
    const [batch] =
      await db.$client`select id from credit_grant where source_ref=${input.adjustmentId}`
    const revoke = creditAdjustmentInput.parse({
      kind: 'revoke',
      adjustmentId: newId(),
      workspaceId,
      grantId: batch?.id,
      reason: '撤回误发',
    })
    const results = await Promise.all(
      [0, 1].map(() =>
        runAdminAction(context, 'credits.adjust', (scope) => adjustAdminCredits(scope, revoke)),
      ),
    )
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect(await getCreditBalance(db, workspaceId)).toEqual({ available: 0, held: 0, debt: 0 })
    expect(await reconcileWorkspaceCredits(db, workspaceId)).toMatchObject({
      consistent: true,
      difference: 0,
    })
  })

  it.each([
    ['订阅', listAdminSubscriptions],
    ['一次性购买', listAdminPurchases],
    ['付款', listAdminPayments],
    ['退款审核', listAdminRefunds],
  ] as const)('%s 按空间筛选发生在服务端分页之前', async (_name, list) => {
    await fixture()
    for (const workspaceId of spaces) {
      const result = await list(db, { workspaceId, offset: 0 })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.workspaceId).toBe(workspaceId)
      expect(result.hasMore).toBe(false)
      expect((await list(db, { workspaceId, offset: 1 })).rows).toHaveLength(0)
    }
  })

  it('回调按 Stripe 元数据、账务 ID 和 PayPal custom_id 关联空间，并排除未关联事件', async () => {
    await fixture()
    for (let i = 0; i < spaces.length; i++) {
      const filtered = await listAdminWebhooks(db, { workspaceId: spaces[i], offset: 0 })
      expect(filtered.rows.map((row) => row.id).sort()).toEqual(
        webhookIds.slice(i * 5, i * 5 + 5).sort(),
      )
      expect(
        (await listAdminWebhooks(db, { workspaceId: spaces[i], offset: 5 })).rows,
      ).toHaveLength(0)
    }
    expect(
      (await listAdminWebhooks(db, { offset: 0 })).rows.some((row) => row.id === webhookIds.at(-1)),
    ).toBe(true)
  })
})
