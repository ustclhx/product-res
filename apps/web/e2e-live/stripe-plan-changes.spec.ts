import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { register } from '../e2e/fixtures.ts'
import { billingEvidence, expectReconciled, saveBillingEvidence } from './acceptance-evidence.ts'
import { liveDb } from './live-env.ts'
import { expectBillingReturn, payOnStripeCheckout, startStripeCheckout } from './stripe-checkout.ts'

const PRO_MONTHLY = /^Pro\b.* · \$19\.00 \/ month$/
const TEAM_MONTHLY = /^Team\b.* · \$49\.00 \/ month$/
const WEBHOOK_WAIT = { timeout: 90_000, intervals: [2000] }
const STRIPE_API_VERSION = '2026-09-30.endive'

// 托管页面包含联系方式与带 token 的 URL，只保留白名单账务证据。
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

interface StripeSubscription {
  id: string
  livemode: boolean
  status: string
  cancel_at_period_end: boolean
  schedule: string | { id: string } | null
  items: {
    has_more: boolean
    data: {
      price: { id: string }
      current_period_start: number
      current_period_end: number
    }[]
  }
}

interface StripeSchedule {
  id: string
  livemode: boolean
  status: string
  subscription: string | { id: string }
  end_behavior: string
  metadata: { saasManaged?: string }
  phases: {
    start_date: number
    end_date: number
    proration_behavior: string | null
    items: { price: string | { id: string }; quantity: number }[]
  }[]
}

interface StripePaymentIntent {
  id: string
  livemode: boolean
  status: string
  amount_received: number
  currency: string
}

function objectId(value: string | { id: string }) {
  return typeof value === 'string' ? value : value.id
}

// 只读远端查询；错误不带出平台响应、请求 URL 或凭据。
async function stripeGet<T extends { id: string; livemode: boolean }>(
  resource: 'subscriptions' | 'subscription_schedules' | 'payment_intents',
  id: string,
): Promise<T> {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret?.startsWith('sk_test_'))
    throw new Error('Plan-change acceptance requires a Stripe test-mode secret')
  const prefix = {
    subscriptions: 'sub_',
    subscription_schedules: 'sub_sched_',
    payment_intents: 'pi_',
  }[resource]
  if (!id.startsWith(prefix) || !/^[a-zA-Z0-9_]+$/.test(id))
    throw new Error('Stripe acceptance object identity is invalid')
  const response = await fetch(`https://api.stripe.com/v1/${resource}/${id}`, {
    headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': STRIPE_API_VERSION },
  }).catch(() => {
    throw new Error('Stripe acceptance read failed')
  })
  if (!response.ok) throw new Error(`Stripe acceptance read returned HTTP ${response.status}`)
  const result = (await response.json()) as T
  if (result.id !== id || result.livemode !== false)
    throw new Error('Stripe acceptance read did not return the requested test-mode object')
  return result
}

async function providerSubscription(id: string) {
  const subscription = await stripeGet<StripeSubscription>('subscriptions', id)
  const item = subscription.items.data[0]
  if (!item || subscription.items.has_more || subscription.items.data.length !== 1)
    throw new Error('Plan-change acceptance requires one subscription item')
  return {
    id: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    providerPriceId: item.price.id,
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
    scheduleId: subscription.schedule ? objectId(subscription.schedule) : null,
  }
}

async function chooseChange(page: Page, price: RegExp) {
  // SSR 已显示选项；ready 控件启用后才写入选择，防止水合覆盖。
  await expect(page.getByRole('combobox', { name: 'Payment method', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Payment method', exact: true }).selectOption('stripe')
  const plan = page.getByRole('combobox', { name: 'Plan', exact: true })
  const option = plan.locator('option', { hasText: price })
  await expect(option).toHaveCount(1)
  const planPriceId = await option.getAttribute('value')
  if (!planPriceId) throw new Error('Plan-change acceptance target price is missing')
  await plan.selectOption(planPriceId)
  await expect(page.getByRole('button', { name: 'Change plan', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Change plan', exact: true }).click()
  return planPriceId
}

test('Stripe Pro 月付立即升级 Team 不追加积分，降级 Pro 只预约周期末生效', async ({ page }) => {
  test.setTimeout(300_000)
  const email = `stripe-plan-change-${randomUUID()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2]
  if (!slug) throw new Error('Registered acceptance workspace slug is missing')
  const sql = liveDb()
  try {
    await startStripeCheckout(page, slug, PRO_MONTHLY)
    await payOnStripeCheckout(page, email)
    await expectBillingReturn(page, slug)
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, slug)
        return {
          payments: evidence.payments.map((payment) => [
            payment.kind,
            payment.status,
            payment.amount,
          ]),
          plans: evidence.subscriptions.map((sub) => [sub.plan_key, sub.status]),
          grants: evidence.grants.filter((grant) => grant.source === 'subscription').length,
          pendingEvents: evidence.events.filter(
            (event) => !['processed', 'ignored'].includes(event.status),
          ).length,
        }
      }, WEBHOOK_WAIT)
      .toEqual({
        payments: [['initial', 'succeeded', 1900]],
        plans: [['pro', 'active']],
        grants: 1,
        pendingEvents: 0,
      })
    const pro = await billingEvidence(sql, slug)
    const subscription = pro.subscriptions[0]
    const initialPayment = pro.payments[0]
    if (!subscription || !initialPayment)
      throw new Error('Initial acceptance subscription is missing')
    expect(subscription).toMatchObject({ interval: 'month', cancel_at_period_end: false })
    expect(initialPayment.provider_payment_id).toMatch(/^pi_/)
    expect(pro.grants.filter((grant) => grant.source === 'subscription')).toEqual([
      expect.objectContaining({ payment_id: initialPayment.id, amount: 1000, remaining: 1000 }),
    ])
    expectReconciled(pro)
    await saveBillingEvidence('plan-change-pro-initial', pro)

    await page.goto(`/app/${slug}/billing`)
    await expect(page.getByText('Current plan: pro', { exact: true })).toBeVisible()
    const teamPriceId = await chooseChange(page, TEAM_MONTHLY)
    await expect(page.getByRole('status')).toHaveText('Subscription updated.')
    // 权益必须由正常操作更新；不得刷新页面掩盖失效的 loader invalidation。
    await expect(page.getByText('Current plan: team', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, slug)
        return {
          payments: evidence.payments.map((payment) => [payment.kind, payment.status]).sort(),
          plans: evidence.subscriptions.map((sub) => sub.plan_key),
          pendingEvents: evidence.events.filter(
            (event) => !['processed', 'ignored'].includes(event.status),
          ).length,
        }
      }, WEBHOOK_WAIT)
      .toEqual({
        payments: [
          ['adjustment', 'succeeded'],
          ['initial', 'succeeded'],
        ],
        plans: ['team'],
        pendingEvents: 0,
      })
    const upgraded = await billingEvidence(sql, slug)
    const adjustment = upgraded.payments.find((payment) => payment.kind === 'adjustment')
    if (!adjustment) throw new Error('Upgrade adjustment payment is missing')
    expect(adjustment).toMatchObject({
      subscription_id: subscription.id,
      purchase_id: null,
      plan_price_id: teamPriceId,
      currency: 'USD',
      refunded_amount: 0,
    })
    expect(adjustment.amount).toBeGreaterThan(0)
    expect(adjustment.amount).toBeLessThanOrEqual(3000)
    expect(adjustment.provider_payment_id).toMatch(/^pi_/)
    expect(upgraded.payments.find((payment) => payment.kind === 'initial')).toEqual(initialPayment)
    expect(new Set(upgraded.payments.map((payment) => payment.provider_payment_id)).size).toBe(2)
    expect(upgraded.subscriptions[0]).toMatchObject({
      id: subscription.id,
      provider_subscription_id: subscription.provider_subscription_id,
      interval: 'month',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: subscription.current_period_end,
    })
    expect(upgraded.grants).toEqual(pro.grants)
    expect(upgraded.ledger).toEqual(pro.ledger)
    expect(upgraded.balance).toEqual(pro.balance)
    expectReconciled(upgraded)
    const teamProvider = await providerSubscription(String(subscription.provider_subscription_id))
    expect(teamProvider).toMatchObject({
      providerPriceId: upgraded.subscriptions[0]?.provider_price_id,
      status: 'active',
      scheduleId: null,
      cancelAtPeriodEnd: false,
    })
    const intent = await stripeGet<StripePaymentIntent>(
      'payment_intents',
      String(adjustment.provider_payment_id),
    )
    const adjustmentProvider = {
      id: intent.id,
      status: intent.status,
      amountReceived: intent.amount_received,
      currency: intent.currency.toUpperCase(),
    }
    expect(adjustmentProvider).toEqual({
      id: adjustment.provider_payment_id,
      status: 'succeeded',
      amountReceived: adjustment.amount,
      currency: adjustment.currency,
    })
    const upgradeEvidence = {
      ...upgraded,
      providerSubscription: teamProvider,
      adjustmentProvider,
    }
    await saveBillingEvidence('plan-change-team-upgraded', upgradeEvidence)

    const proPriceId = await chooseChange(page, PRO_MONTHLY)
    expect(proPriceId).toBe(initialPayment.plan_price_id)
    await expect(page.getByRole('status')).toHaveText(
      'Plan change scheduled for the end of your paid period.',
    )
    await expect(page.getByText('Current plan: team', { exact: true })).toBeVisible()
    const scheduledProvider = await providerSubscription(
      String(subscription.provider_subscription_id),
    )
    expect(scheduledProvider).toMatchObject({
      providerPriceId: teamProvider.providerPriceId,
      status: 'active',
      periodStart: teamProvider.periodStart,
      periodEnd: teamProvider.periodEnd,
      cancelAtPeriodEnd: false,
    })
    if (!scheduledProvider.scheduleId) throw new Error('Downgrade Stripe schedule is missing')
    const schedule = await stripeGet<StripeSchedule>(
      'subscription_schedules',
      scheduledProvider.scheduleId,
    )
    expect(objectId(schedule.subscription)).toBe(subscription.provider_subscription_id)
    expect(schedule.metadata.saasManaged).toBe('plan_change')
    const futureChange = {
      scheduleId: schedule.id,
      status: schedule.status,
      endBehavior: schedule.end_behavior,
      phases: schedule.phases.map((phase) => ({
        start: phase.start_date,
        end: phase.end_date,
        prorationBehavior: phase.proration_behavior,
        items: phase.items.map((item) => ({
          providerPriceId: objectId(item.price),
          quantity: item.quantity,
        })),
      })),
    }
    const [proPrice] =
      await sql`select provider_price_id from plan_price where id = ${proPriceId} and provider = 'stripe'`
    if (!proPrice) throw new Error('Downgrade provider price mapping is missing')
    expect(futureChange.status).toBe('active')
    expect(futureChange.endBehavior).toBe('release')
    expect(futureChange.phases).toHaveLength(2)
    expect(futureChange.phases[0]).toMatchObject({
      start: teamProvider.periodStart,
      end: teamProvider.periodEnd,
      prorationBehavior: 'none',
      items: [{ providerPriceId: teamProvider.providerPriceId, quantity: 1 }],
    })
    expect(futureChange.phases[1]).toMatchObject({
      start: teamProvider.periodEnd,
      prorationBehavior: 'none',
      items: [{ providerPriceId: proPrice.provider_price_id, quantity: 1 }],
    })
    expect(futureChange.phases[1]?.end).toBeGreaterThan(teamProvider.periodEnd)
    expect(teamProvider.periodEnd).toBe(new Date(subscription.current_period_end).getTime() / 1000)
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, slug)
        return evidence.events.filter((event) => !['processed', 'ignored'].includes(event.status))
          .length
      }, WEBHOOK_WAIT)
      .toBe(0)
    const scheduled = await billingEvidence(sql, slug)
    expect(scheduled.subscriptions).toEqual(upgraded.subscriptions)
    expect(scheduled.payments).toEqual(upgraded.payments)
    expect(scheduled.grants).toEqual(upgraded.grants)
    expect(scheduled.ledger).toEqual(upgraded.ledger)
    expect(scheduled.balance).toEqual(upgraded.balance)
    expectReconciled(scheduled)
    // 这里只验当前周期和未来 schedule；实际周期末切换另用平台 test clock 验证。
    const downgradeEvidence = {
      ...scheduled,
      providerSubscription: scheduledProvider,
      futureChange,
    }
    await saveBillingEvidence('plan-change-pro-downgrade-scheduled', downgradeEvidence)
  } finally {
    await sql.end()
  }
})
