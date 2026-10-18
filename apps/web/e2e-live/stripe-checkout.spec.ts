import { expect, test } from '@playwright/test'
import { register } from '../e2e/fixtures.ts'
import { liveDb } from './live-env.ts'
import { expectBillingReturn, payOnStripeCheckout, startStripeCheckout } from './stripe-checkout.ts'

const PRO_MONTHLY = /^Pro\b.* · \$19\.00 \/ month$/

// tasks.md 10.1：从定价页进入，在 Stripe 托管结账页用官方测试卡付款，回跳应用后
// 由真实签名回调入账：付款 succeeded，且首付只发放一份订阅积分（Pro 每月 1000）。
// 本地与 staging 共用（见 live-env.ts）；staging 上回调由 Stripe 直接投递到 workers.dev。
test('Stripe 测试卡订阅：从定价页结账、回跳与回调入账只发放一次积分', async ({ page }) => {
  const email = `stripe-live-${Date.now()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2] as string

  await page.goto('/pricing')
  await page.getByLabel('Payment method').selectOption('stripe')
  const pro = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Pro\b/ }) })
  await expect(pro.getByText('$19.00 / month')).toBeVisible()
  await pro.getByRole('link', { name: 'View in my workspace' }).click()
  await expect(page).toHaveURL(new RegExp(`/app/${slug}`))

  await startStripeCheckout(page, slug, PRO_MONTHLY)
  await payOnStripeCheckout(page, email)
  await expectBillingReturn(page, slug)

  const sql = liveDb()
  try {
    // 真实回调异步到达：轮询直到付款入账
    await expect
      .poll(
        async () => {
          const rows = await sql`select p.status, p.kind, p.amount from payment p
            join organization o on o.id = p.workspace_id where o.slug = ${slug}`
          return rows.map((r) => `${r.kind}:${r.status}:${r.amount}`)
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toEqual(['initial:succeeded:1900'])
    const grants = await sql`select g.source, g.amount from credit_grant g
      join organization o on o.id = g.workspace_id where o.slug = ${slug} and g.source = 'subscription'`
    expect(grants.map((g) => `${g.source}:${g.amount}`)).toEqual(['subscription:1000'])
    const [sub] = await sql`select s.status, s.provider from subscription s
      join organization o on o.id = s.workspace_id where o.slug = ${slug}`
    expect(sub).toMatchObject({ status: 'active', provider: 'stripe' })
  } finally {
    await sql.end()
  }
})
