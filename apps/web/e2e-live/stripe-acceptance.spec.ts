import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { register } from '../e2e/fixtures.ts'
import { billingEvidence, expectReconciled, saveBillingEvidence } from './acceptance-evidence.ts'
import { liveDb } from './live-env.ts'
import { expectBillingReturn, payOnStripeCheckout, startStripeCheckout } from './stripe-checkout.ts'

const PRO_MONTHLY = /^Pro\b.* · \$19\.00 \/ month$/
const PRO_YEARLY = /^Pro\b.* · \$190\.00 \/ year$/
const TEAM_MONTHLY = /^Team\b.* · \$49\.00 \/ month$/
const CREDIT_PACK = /^Credit pack\b.* · \$10\.00$/
const WEBHOOK_WAIT = { timeout: 90_000, intervals: [2000] }

// 托管页面含联系方式及带 token 的 URL，验收仅保存白名单账务证据。
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function newOwner(page: Page) {
  const email = `stripe-acceptance-${randomUUID()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2]
  if (!slug) throw new Error('Registered workspace slug is missing')
  return { email, slug }
}

async function pay(page: Page, owner: { email: string; slug: string }, price: RegExp) {
  await startStripeCheckout(page, owner.slug, price)
  await payOnStripeCheckout(page, owner.email)
  await expectBillingReturn(page, owner.slug)
}

async function settled(sql: ReturnType<typeof liveDb>, slug: string, amounts: number[]) {
  await expect
    .poll(async () => {
      const evidence = await billingEvidence(sql, slug)
      const payments = evidence.payments.filter((payment) => payment.status === 'succeeded')
      return {
        amounts: payments.map((payment) => payment.amount).sort((a, b) => a - b),
        grants: evidence.grants.filter((grant) => grant.payment_id !== null).length,
        pendingEvents: evidence.events.filter(
          (event) => !['processed', 'ignored'].includes(event.status),
        ).length,
      }
    }, WEBHOOK_WAIT)
    .toEqual({
      amounts: [...amounts].sort((a, b) => a - b),
      grants: amounts.length,
      pendingEvents: 0,
    })
  return billingEvidence(sql, slug)
}

test('Stripe 年付 Pro 首付只发放首月 1000 积分', async ({ page }) => {
  const owner = await newOwner(page)
  const sql = liveDb()
  try {
    const before = await billingEvidence(sql, owner.slug)
    await pay(page, owner, PRO_YEARLY)
    const evidence = await settled(sql, owner.slug, [19000])
    expect(evidence.payments).toHaveLength(1)
    expect(evidence.payments[0]).toMatchObject({ kind: 'initial', refunded_amount: 0 })
    expect(evidence.subscriptions).toHaveLength(1)
    expect(evidence.subscriptions[0]).toMatchObject({
      plan_key: 'pro',
      interval: 'year',
      status: 'active',
    })
    expect(evidence.grants.filter((grant) => grant.source === 'subscription')).toEqual([
      expect.objectContaining({
        amount: 1000,
        remaining: 1000,
        payment_id: evidence.payments[0]?.id,
      }),
    ])
    expect(evidence.balance.available - before.balance.available).toBe(1000)
    expectReconciled(evidence)
    await saveBillingEvidence('pro-yearly-initial', evidence)
  } finally {
    await sql.end()
  }
})

test('Stripe 积分包入账与用户退款申请仅进入 pending', async ({ page }) => {
  const owner = await newOwner(page)
  const sql = liveDb()
  try {
    const before = await billingEvidence(sql, owner.slug)
    await pay(page, owner, CREDIT_PACK)
    const paid = await settled(sql, owner.slug, [1000])
    expect(paid.subscriptions).toHaveLength(0)
    expect(paid.purchases).toEqual([expect.objectContaining({ status: 'paid', amount: 1000 })])
    expect(paid.payments).toEqual([
      expect.objectContaining({ kind: 'one_time', refunded_amount: 0 }),
    ])
    expect(paid.grants.filter((grant) => grant.source === 'purchase')).toEqual([
      expect.objectContaining({ amount: 1000, remaining: 1000, payment_id: paid.payments[0]?.id }),
    ])
    expect(paid.balance.available - before.balance.available).toBe(1000)
    expectReconciled(paid)
    await saveBillingEvidence('credit-pack-paid', paid)

    await page.goto(`/app/${owner.slug}/billing`)
    // 退款输入在 SSR 已可操作；先等父页面的 ready 控件启用，避免水合覆盖输入。
    await expect(page.getByRole('combobox', { name: 'Payment method', exact: true })).toBeEnabled()
    const form = page.getByRole('form', { name: 'Request a refund' })
    await form
      .getByRole('combobox', { name: 'Payment', exact: true })
      .selectOption(String(paid.payments[0]?.id))
    await form.getByLabel('Reason').fill('Stripe staging acceptance refund request')
    await form.getByLabel('Contact email').fill(owner.email)
    await expect(form.getByRole('button', { name: 'Submit refund request' })).toBeEnabled()
    await form.getByRole('button', { name: 'Submit refund request' }).click()
    await expect(page.getByRole('status')).toHaveText(/Refund request submitted/)
    await expect
      .poll(async () => {
        const evidence = await billingEvidence(sql, owner.slug)
        return evidence.refunds.map((refund) => refund.status)
      }, WEBHOOK_WAIT)
      .toEqual(['pending'])
    const evidence = await billingEvidence(sql, owner.slug)
    expect(evidence.refunds[0]).toMatchObject({
      payment_id: paid.payments[0]?.id,
      approved_amount: null,
      provider_refund_id: null,
    })
    expect(evidence.payments).toEqual(paid.payments)
    expect(evidence.grants).toEqual(paid.grants)
    expect(evidence.ledger).toEqual(paid.ledger)
    expectReconciled(evidence)
    await saveBillingEvidence('credit-pack-refund-pending', evidence)
  } finally {
    await sql.end()
  }
})

test('Stripe 月付取消与恢复保留已付周期且不重复发积分', async ({ page }) => {
  const owner = await newOwner(page)
  const sql = liveDb()
  try {
    await pay(page, owner, PRO_MONTHLY)
    const paid = await settled(sql, owner.slug, [1900])
    expect(paid.subscriptions).toHaveLength(1)
    await page.goto(`/app/${owner.slug}/billing`)
    await page.getByRole('button', { name: 'Cancel at period end', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Resume subscription', exact: true }),
    ).toBeEnabled()
    const canceled = await billingEvidence(sql, owner.slug)
    expect(canceled.subscriptions[0]).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: paid.subscriptions[0]?.current_period_end,
    })
    expect(canceled.grants).toEqual(paid.grants)
    await saveBillingEvidence('pro-monthly-canceled', canceled)
    await page.getByRole('button', { name: 'Resume subscription', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Cancel at period end', exact: true }),
    ).toBeEnabled()
    const evidence = await settled(sql, owner.slug, [1900])
    expect(evidence.subscriptions[0]).toMatchObject({
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: paid.subscriptions[0]?.current_period_end,
    })
    expect(evidence.payments).toEqual(paid.payments)
    expect(evidence.grants).toEqual(paid.grants)
    expect(evidence.ledger).toEqual(paid.ledger)
    expectReconciled(evidence)
    await saveBillingEvidence('pro-monthly-resumed', evidence)
  } finally {
    await sql.end()
  }
})

test('Stripe 已配置 Customer Portal 可以打开并返回账单页', async ({ page }) => {
  const owner = await newOwner(page)
  const sql = liveDb()
  try {
    await pay(page, owner, PRO_MONTHLY)
    const paid = await settled(sql, owner.slug, [1900])
    await page.goto(`/app/${owner.slug}/billing`)
    await page.getByRole('button', { name: 'Open billing portal', exact: true }).click()
    await page.waitForURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 60_000 })
    await page.getByRole('link', { name: /return to/i }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${owner.slug}/billing$`))
    await expect(
      page.getByRole('button', { name: 'Open billing portal', exact: true }),
    ).toBeEnabled()
    const evidence = await billingEvidence(sql, owner.slug)
    expect(evidence.payments).toEqual(paid.payments)
    expect(evidence.grants).toEqual(paid.grants)
    expectReconciled(evidence)
    await saveBillingEvidence('portal-open-return', evidence)
  } finally {
    await sql.end()
  }
})

test('Stripe Pro 取消后购买 Team：重叠周期各自发积分且只有 Team 续费', async ({ page }) => {
  test.setTimeout(300_000)
  const owner = await newOwner(page)
  const sql = liveDb()
  try {
    const before = await billingEvidence(sql, owner.slug)
    await pay(page, owner, PRO_MONTHLY)
    const pro = await settled(sql, owner.slug, [1900])
    await page.goto(`/app/${owner.slug}/billing`)
    await page.getByRole('button', { name: 'Cancel at period end', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Resume subscription', exact: true }),
    ).toBeEnabled()
    await pay(page, owner, TEAM_MONTHLY)
    const evidence = await settled(sql, owner.slug, [1900, 4900])
    expect(evidence.subscriptions).toHaveLength(2)
    expect(evidence.subscriptions.find((sub) => sub.plan_key === 'pro')).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: pro.subscriptions[0]?.current_period_end,
    })
    expect(evidence.subscriptions.find((sub) => sub.plan_key === 'team')).toMatchObject({
      status: 'active',
      cancel_at_period_end: false,
    })
    expect(
      evidence.subscriptions.filter(
        (sub) =>
          !sub.cancel_at_period_end &&
          ['active', 'trialing', 'past_due', 'paused'].includes(sub.status),
      ),
    ).toHaveLength(1)
    expect(
      evidence.subscriptions.every(
        (sub) => new Date(sub.current_period_end).getTime() > Date.now(),
      ),
    ).toBe(true)
    for (const payment of evidence.payments) {
      expect(payment.kind).toBe('initial')
      expect(evidence.grants.filter((grant) => grant.payment_id === payment.id)).toEqual([
        expect.objectContaining({
          source: 'subscription',
          amount: payment.amount === 1900 ? 1000 : 5000,
        }),
      ])
    }
    expect(evidence.balance.available - before.balance.available).toBe(6000)
    expectReconciled(evidence)
    await page.goto(`/app/${owner.slug}/billing`)
    await expect(page.getByText('Current plan: team', { exact: true })).toBeVisible()
    await expect(page.getByText(/Paid subscription periods overlap/)).toBeVisible()
    await saveBillingEvidence('pro-team-overlap', evidence)
  } finally {
    await sql.end()
  }
})
