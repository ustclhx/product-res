import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { register } from '../e2e/fixtures.ts'
import {
  type BillingEvidence,
  billingEvidence,
  expectReconciled,
  saveBillingEvidence,
} from './acceptance-evidence.ts'
import { liveDb, liveTarget } from './live-env.ts'
import {
  chooseChange,
  expectBillingReturn,
  payOnStripeCheckout,
  startStripeCheckout,
} from './stripe-checkout.ts'
import {
  advanceTestClockTo,
  createClockCustomer,
  createTestClock,
  customerInvoices,
  deleteTestClock,
  productInvoiceKind,
  scheduleSummary,
  subscriptionSummary,
  type TestClock,
} from './stripe-test-clock.ts'

// harden-audit-findings 7.3：月付与年付互换在当前周期结束时生效（specs/subscriptions「Stripe 升降级」）。
// 应用的 Stripe customer 挂在测试时钟上，经应用 UI 订阅与切换，推进时钟后核对 Stripe 与本地入账。
//
// 测试时钟只能在创建 customer 时指定，而应用只在 Checkout 中以 customer_email 让 Stripe 新建 customer，
// 已有 billing_customer 映射时才复用（packages/billing/src/services.ts checkout）。因此本地预先写入
// 本 worktree 隔离库的 billing_customer 映射接入；staging 不能写库，这组用例在 staging 跳过，
// 改由 stripe-test-clock-experiment.ts 做平台侧实验（见 PR 说明）。
const PRO_MONTHLY = /^Pro\b.* · \$19\.00 \/ month$/
const PRO_YEARLY = /^Pro\b.* · \$190\.00 \/ year$/
const INTERVAL_NOTICE =
  /^Switching between monthly and annual billing takes effect at the end of your current billing period/
const SCHEDULED = 'Plan change scheduled for the end of your current billing period.'
const WEBHOOK_WAIT = { timeout: 120_000, intervals: [2000] }
const DAY = 86_400

// 托管页面包含联系方式与带 token 的 URL，只保留白名单账务证据。
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test.skip(
  liveTarget === 'staging',
  'staging 不能预置测试时钟 customer 映射；改跑 stripe-test-clock-experiment.ts（平台侧）',
)

type LiveSql = ReturnType<typeof liveDb>

const seconds = (value: unknown) => new Date(String(value)).getTime() / 1000

/** 新周期的日历长度（月付 28–31 天、年付 365/366 天），与 Stripe 的同日锚点一致 */
function calendarLength(start: number, interval: 'month' | 'year') {
  const end = new Date(start * 1000)
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return end.getTime() / 1000 - start
}

function pending(evidence: BillingEvidence) {
  return evidence.events.filter((event) => !['processed', 'ignored'].includes(event.status))
}

/** 注册新空间，并把挂在测试时钟上的 Stripe customer 预置为该空间的映射 */
async function clockOwner(page: Page, sql: LiveSql, name: string) {
  const email = `stripe-interval-${randomUUID()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2]
  if (!slug) throw new Error('Registered acceptance workspace slug is missing')
  const clock = await createTestClock(name)
  const customer = await createClockCustomer(clock.id, email, false)
  const [workspace] = await sql`select id from organization where slug = ${slug}`
  if (!workspace) throw new Error('Registered acceptance workspace is missing')
  await sql`insert into billing_customer (id, workspace_id, provider, provider_customer_id)
    values (${newId()}, ${String(workspace.id)}, 'stripe', ${customer.id})`
  return { email, slug, clock, customerId: customer.id }
}

async function subscribe(
  page: Page,
  sql: LiveSql,
  owner: { email: string; slug: string },
  price: RegExp,
  amount: number,
) {
  await startStripeCheckout(page, owner.slug, price)
  await payOnStripeCheckout(page, owner.email)
  await expectBillingReturn(page, owner.slug)
  await expect
    .poll(async () => {
      const evidence = await billingEvidence(sql, owner.slug)
      return {
        payments: evidence.payments.map((payment) => [
          payment.kind,
          payment.status,
          payment.amount,
        ]),
        plans: evidence.subscriptions.map((sub) => [sub.plan_key, sub.status]),
        grants: evidence.grants.filter((grant) => grant.source === 'subscription').length,
        pendingEvents: pending(evidence).length,
      }
    }, WEBHOOK_WAIT)
    .toEqual({
      payments: [['initial', 'succeeded', amount]],
      plans: [['pro', 'active']],
      grants: 1,
      pendingEvents: 0,
    })
  return billingEvidence(sql, owner.slug)
}

/**
 * 经 UI 发起周期变更，并核对：Stripe 生成两段 schedule、当前周期不开票不扣款、本地账务不变。
 * 返回切换前的 Stripe 订阅与目标价格映射，供周期末核对。
 */
async function scheduleIntervalChange(
  page: Page,
  sql: LiveSql,
  owner: { slug: string; customerId: string },
  paid: BillingEvidence,
  target: RegExp,
  targetInterval: 'month' | 'year',
) {
  const subscription = paid.subscriptions[0]
  if (!subscription) throw new Error('Interval-change acceptance subscription is missing')
  const before = await subscriptionSummary(String(subscription.provider_subscription_id))
  await page.goto(`/app/${owner.slug}/billing`)
  await expect(page.getByText(/^Current plan: Pro\b/)).toBeVisible()
  const targetPriceId = await chooseChange(page, target, INTERVAL_NOTICE)
  // 页面可能同时有每日领取等其他状态区域，按文字筛选
  await expect(page.getByRole('status').filter({ hasText: SCHEDULED })).toBeVisible()
  await expect(page.getByText(/^Current plan: Pro\b/)).toBeVisible()
  const [mapping] = await sql`select provider_price_id, interval from plan_price
    where id = ${targetPriceId} and provider = 'stripe'`
  if (!mapping) throw new Error('Interval-change target price mapping is missing')
  expect(mapping.interval).toBe(targetInterval)
  const targetProviderPriceId = String(mapping.provider_price_id)

  const scheduled = await subscriptionSummary(before.id)
  expect(scheduled).toMatchObject({
    status: 'active',
    priceId: before.priceId,
    periodStart: before.periodStart,
    periodEnd: before.periodEnd,
    cancelAtPeriodEnd: false,
  })
  if (!scheduled.scheduleId) throw new Error('Interval-change Stripe schedule is missing')
  const schedule = await scheduleSummary(scheduled.scheduleId)
  expect(schedule).toMatchObject({
    status: 'active',
    endBehavior: 'release',
    saasManaged: 'plan_change',
  })
  expect(schedule.phases).toHaveLength(2)
  expect(schedule.phases[0]).toMatchObject({
    start: before.periodStart,
    end: before.periodEnd,
    prorationBehavior: 'none',
    items: [{ providerPriceId: before.priceId, quantity: 1 }],
  })
  expect(schedule.phases[1]).toMatchObject({
    start: before.periodEnd,
    prorationBehavior: 'none',
    items: [{ providerPriceId: targetProviderPriceId, quantity: 1 }],
  })
  // 当前周期不开票、不扣款：仍只有首付那一张发票
  const invoices = await customerInvoices(owner.customerId)
  expect(
    invoices.map((invoice) => [invoice.billingReason, invoice.status, invoice.amountPaid]),
  ).toEqual([['subscription_create', 'paid', paid.payments[0]?.amount]])
  await expect
    .poll(async () => pending(await billingEvidence(sql, owner.slug)).length, WEBHOOK_WAIT)
    .toBe(0)
  const evidence = await billingEvidence(sql, owner.slug)
  expect(evidence.subscriptions).toEqual(paid.subscriptions)
  expect(evidence.payments).toEqual(paid.payments)
  expect(evidence.grants).toEqual(paid.grants)
  expect(evidence.ledger).toEqual(paid.ledger)
  expectReconciled(evidence)
  return { before, schedule, invoices, targetPriceId, targetProviderPriceId, evidence }
}

/**
 * 推进到周期末之后，先核对 Stripe 侧（订阅改为新周期、开出新周期发票并付款），再核对本地入账。
 * 证据先于断言保存，失败时也保留 billing_reason 与事件序列。
 */
async function expectSwitchedAtPeriodEnd(
  sql: LiveSql,
  owner: { slug: string; customerId: string; clock: TestClock },
  paid: BillingEvidence,
  change: Awaited<ReturnType<typeof scheduleIntervalChange>>,
  expected: { interval: 'month' | 'year'; amount: number },
  scenario: string,
) {
  await advanceTestClockTo(owner.clock, change.before.periodEnd + DAY)
  const after = await subscriptionSummary(change.before.id)
  const invoices = await customerInvoices(owner.customerId)
  const transition = invoices.find((invoice) => invoice.created >= change.before.periodEnd) ?? null
  const transitionSummary = transition && {
    invoiceId: transition.id,
    billingReason: transition.billingReason,
    productKind: await productInvoiceKind(transition.id),
    status: transition.status,
    amountPaid: transition.amountPaid,
    lines: transition.lines,
  }
  test.info().annotations.push({
    type: 'billing_reason',
    description: `${scenario}: ${transition?.billingReason ?? 'no transition invoice'}`,
  })
  // 等待周期末回调处理完成后再取证；平台未开票时不会有新付款，直接取当前状态。
  if (transition?.status === 'paid')
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, owner.slug)
        return evidence.payments.length > paid.payments.length && pending(evidence).length === 0
      }, WEBHOOK_WAIT)
      .toBe(true)
      .catch(() => undefined)
  const settled = await billingEvidence(sql, owner.slug)
  await saveBillingEvidence(scenario, {
    ...settled,
    providerSubscriptionBefore: change.before,
    providerSubscriptionAfter: after,
    schedule: change.schedule,
    providerInvoices: invoices,
    transition: transitionSummary,
  } as BillingEvidence)

  await test.step('Stripe：周期末切换为新周期并开出新周期发票', async () => {
    expect(after).toMatchObject({
      status: 'active',
      priceId: change.targetProviderPriceId,
      interval: expected.interval,
      periodStart: change.before.periodEnd,
    })
    expect(after.periodEnd - after.periodStart).toBe(
      calendarLength(change.before.periodEnd, expected.interval),
    )
    expect(invoices).toHaveLength(2)
    expect(transitionSummary).toMatchObject({
      status: 'paid',
      amountPaid: expected.amount,
      lines: [
        expect.objectContaining({
          priceId: change.targetProviderPriceId,
          amount: expected.amount,
          proration: false,
        }),
      ],
    })
  })

  await test.step('应用：新周期付款按续费入账并发放 1000 积分', async () => {
    // 产品分类（classifyStripeBillingReason + 发票行）须把新周期首期归为续费，才会发放积分
    expect(transitionSummary?.productKind).toBe('renewal')
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, owner.slug)
        return {
          payments: evidence.payments.map((payment) => [
            payment.kind,
            payment.status,
            payment.amount,
          ]),
          plans: evidence.subscriptions.map((sub) => [sub.plan_key, sub.status, sub.interval]),
          grants: evidence.grants.filter((grant) => grant.source === 'subscription').length,
          failedEvents: evidence.events.filter((event) => event.status === 'failed').length,
          pendingEvents: pending(evidence).length,
        }
      }, WEBHOOK_WAIT)
      .toEqual({
        payments: [
          ['initial', 'succeeded', paid.payments[0]?.amount],
          ['renewal', 'succeeded', expected.amount],
        ],
        plans: [['pro', 'active', expected.interval]],
        grants: 2,
        failedEvents: 0,
        pendingEvents: 0,
      })
    const evidence = await billingEvidence(sql, owner.slug)
    const renewal = evidence.payments.find((payment) => payment.kind === 'renewal')
    if (!renewal) throw new Error('Interval-change renewal payment is missing')
    expect(renewal).toMatchObject({
      subscription_id: paid.subscriptions[0]?.id,
      plan_price_id: change.targetPriceId,
      currency: 'USD',
      refunded_amount: 0,
    })
    expect(seconds(renewal.period_start)).toBe(change.before.periodEnd)
    expect(seconds(renewal.period_end)).toBe(after.periodEnd)
    expect(evidence.subscriptions[0]).toMatchObject({
      id: paid.subscriptions[0]?.id,
      provider_price_id: change.targetProviderPriceId,
      cancel_at_period_end: false,
    })
    expect(seconds(evidence.subscriptions[0]?.current_period_start)).toBe(change.before.periodEnd)
    expect(seconds(evidence.subscriptions[0]?.current_period_end)).toBe(after.periodEnd)
    // 年付与月付每月都发 1000：新周期首笔付款只发首月一笔
    expect(evidence.grants.filter((grant) => grant.payment_id === renewal.id)).toEqual([
      expect.objectContaining({ source: 'subscription', amount: 1000, remaining: 1000 }),
    ])
    expect(evidence.balance.available - paid.balance.available).toBe(1000)
    expectReconciled(evidence)
  })
}

test('Stripe 月付 Pro 切换年付：当前周期不开票，周期末开出年付发票并按续费入账', async ({
  page,
}) => {
  test.setTimeout(480_000)
  const sql = liveDb()
  let clock: TestClock | undefined
  try {
    const owner = await clockOwner(page, sql, 'monthly-to-yearly')
    clock = owner.clock
    const paid = await subscribe(page, sql, owner, PRO_MONTHLY, 1900)
    expect(paid.subscriptions[0]).toMatchObject({ interval: 'month', cancel_at_period_end: false })
    await saveBillingEvidence('interval-monthly-initial', paid)
    const change = await scheduleIntervalChange(page, sql, owner, paid, PRO_YEARLY, 'year')
    await saveBillingEvidence('interval-monthly-to-yearly-scheduled', {
      ...change.evidence,
      providerSubscription: change.before,
      schedule: change.schedule,
      providerInvoices: change.invoices,
    } as BillingEvidence)
    await expectSwitchedAtPeriodEnd(
      sql,
      owner,
      paid,
      change,
      { interval: 'year', amount: 19000 },
      'interval-monthly-to-yearly-period-end',
    )
  } finally {
    if (clock) await deleteTestClock(clock.id)
    await sql.end()
  }
})

test('Stripe 年付 Pro 切换月付：schedule 正确，周期末按月付续费入账', async ({ page }) => {
  test.setTimeout(600_000)
  const sql = liveDb()
  let clock: TestClock | undefined
  try {
    const owner = await clockOwner(page, sql, 'yearly-to-monthly')
    clock = owner.clock
    const paid = await subscribe(page, sql, owner, PRO_YEARLY, 19000)
    expect(paid.subscriptions[0]).toMatchObject({ interval: 'year', cancel_at_period_end: false })
    await saveBillingEvidence('interval-yearly-initial', paid)
    const change = await scheduleIntervalChange(page, sql, owner, paid, PRO_MONTHLY, 'month')
    await saveBillingEvidence('interval-yearly-to-monthly-scheduled', {
      ...change.evidence,
      providerSubscription: change.before,
      schedule: change.schedule,
      providerInvoices: change.invoices,
    } as BillingEvidence)
    await expectSwitchedAtPeriodEnd(
      sql,
      owner,
      paid,
      change,
      { interval: 'month', amount: 1900 },
      'interval-yearly-to-monthly-period-end',
    )
  } finally {
    if (clock) await deleteTestClock(clock.id)
    await sql.end()
  }
})
