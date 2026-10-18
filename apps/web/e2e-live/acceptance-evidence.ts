import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { liveDb } from './live-env.ts'

type LiveSql = ReturnType<typeof liveDb>

// 只选核验需要的白名单字段；禁止带出 raw、payload、联系方式、URL 或配置。
export async function billingEvidence(sql: LiveSql, slug: string) {
  const [workspace] = await sql`select o.id as workspace_id, m.user_id
    from organization o join member m on m.organization_id = o.id
    where o.slug = ${slug} and m.role = 'owner'`
  if (!workspace) throw new Error('Registered acceptance workspace is missing')
  const workspaceId = String(workspace.workspace_id)
  const payments = await sql`select id, provider_payment_id, subscription_id, purchase_id,
    kind, amount, currency, status, refunded_amount, plan_price_id, period_start, period_end
    from payment where workspace_id = ${workspaceId} order by id`
  const subscriptions = await sql`select s.id, s.provider_subscription_id, s.status,
    s.cancel_at_period_end, s.current_period_start, s.current_period_end,
    p.key as plan_key, pp.interval, pp.provider_price_id
    from subscription s join plan p on p.id = s.plan_id
    join plan_price pp on pp.id = s.plan_price_id
    where s.workspace_id = ${workspaceId} order by s.id`
  const purchases = await sql`select id, provider_order_id, status, amount, currency
    from purchase where workspace_id = ${workspaceId} order by id`
  const grants = await sql`select id, source, payment_id, amount, remaining, status, expires_at
    from credit_grant where workspace_id = ${workspaceId} order by id`
  const ledger = await sql`select id, grant_id, type, delta
    from credit_ledger where workspace_id = ${workspaceId} order by id`
  const refunds = await sql`select id, payment_id, status, requested_amount,
    approved_amount, provider_refund_id
    from refund_request where workspace_id = ${workspaceId} order by id`
  const customers = await sql`select id, provider_customer_id from billing_customer
    where workspace_id = ${workspaceId} and provider = 'stripe'`
  // 在数据库内关联 Stripe 对象，不把包含邮箱、地址等信息的事件 payload 带出数据库。
  const events = await sql`select e.id, e.provider_event_id, e.type, e.status, e.attempts
    from webhook_event e where e.provider = 'stripe' and (
      e.payload #>> '{data,object,metadata,workspaceId}' = ${workspaceId}
      or e.payload #>> '{data,object,parent,subscription_details,metadata,workspaceId}' = ${workspaceId}
      or e.payload #>> '{data,object,customer}' in (
        select provider_customer_id from billing_customer
        where workspace_id = ${workspaceId} and provider = 'stripe'
      )
    ) order by e.id`
  const [balance] = await sql`select
    coalesce((select sum(remaining) from credit_grant where workspace_id = ${workspaceId}
      and status = 'active' and (expires_at is null or expires_at > now())), 0)::integer as available,
    coalesce((select sum(amount) from credit_hold where workspace_id = ${workspaceId}
      and status = 'held'), 0)::integer as held,
    coalesce((select amount from credit_debt where workspace_id = ${workspaceId}), 0) as debt,
    coalesce((select sum(delta) from credit_ledger where workspace_id = ${workspaceId}), 0)::integer as ledger_total`
  if (!balance) throw new Error('Acceptance credit balance is missing')
  return {
    workspaceId,
    userId: String(workspace.user_id),
    customers,
    payments,
    subscriptions,
    purchases,
    grants,
    ledger,
    refunds,
    events,
    balance,
  }
}

export type BillingEvidence = Awaited<ReturnType<typeof billingEvidence>>

export function expectReconciled(evidence: BillingEvidence) {
  // 新验收用户没有消费、预扣或债务；注册赠送也必须参与余额与流水对账。
  expect(evidence.balance.held).toBe(0)
  expect(evidence.balance.debt).toBe(0)
  expect(evidence.balance.available).toBeGreaterThanOrEqual(0)
  expect(evidence.balance.available).toBe(evidence.balance.ledger_total)
  expect(evidence.grants.every((grant) => grant.remaining >= 0)).toBe(true)
}

export async function saveBillingEvidence(scenario: string, evidence: BillingEvidence) {
  const directory = process.env.STRIPE_ACCEPTANCE_EVIDENCE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${scenario}-${evidence.workspaceId}.json`),
    `${JSON.stringify({ scenario, capturedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`,
    { mode: 0o600 },
  )
}
