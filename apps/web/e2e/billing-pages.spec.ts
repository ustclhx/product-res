import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { capture, grant, hold } from '@product-res/credits'
import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('public pricing describes unavailable payments without a checkout success', async ({
  page,
}) => {
  await page.goto('/pricing')
  await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible()
  await expect(
    page.getByText('Plans shown here are template examples.', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Payments are currently unavailable')
  await expect(page.getByRole('button', { name: /checkout|pay now/i })).toHaveCount(0)
})

test('billing and usage require a fresh authenticated workspace session', async ({ page }) => {
  await page.goto('/app/no-session/billing')
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/app/no-session/usage')
  await expect(page).toHaveURL(/\/login/)
})

test('PayPal return offers capture only for an uncanceled order', async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
  await register(page, `billing-return-${randomUUID()}@example.com`)
  const workspacePath = new URL(page.url()).pathname.replace(/\/$/, '')
  const confirmPayment = page.getByRole('button', { name: 'Confirm payment', exact: true })
  for (const { name, query, canConfirm } of [
    {
      name: 'subscription',
      query: 'provider=paypal&subscription_id=I-SUBSCRIPTION&ba_token=BA-TOKEN&token=8F-TOKEN',
      canConfirm: false,
    },
    { name: 'order', query: 'provider=paypal&token=ORDER-TOKEN', canConfirm: true },
    {
      name: 'canceled order',
      query: 'provider=paypal&token=ORDER-TOKEN&canceled=true',
      canConfirm: false,
    },
  ]) {
    await test.step(name, async () => {
      await page.goto(`${workspacePath}/billing-return?${query}`)
      await expect(page.getByRole('heading', { name: 'Checkout return' })).toBeVisible()
      if (canConfirm) await expect(confirmPayment).toBeEnabled()
      else await expect(confirmPayment).toHaveCount(0)
    })
  }
})

test('ordinary members see their own ledger without workspace credits or billing history', async ({
  page,
}) => {
  const sql = fixtureDb()
  const email = `billing-member-${randomUUID()}@example.com`
  const workspaceId = randomUUID()
  const usageRef = randomUUID()
  const slug = `billing-${workspaceId}`
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing registered fixture')
    await sql`insert into organization (id,name,slug) values (${workspaceId},'Billing privacy fixture',${slug})`
    await sql`insert into member (id,organization_id,user_id,role) values (${randomUUID()},${workspaceId},${account.id},'member')`
    const url = readLocalEnv('DATABASE_URL')
    if (!url) throw new Error('Missing isolated worktree database')
    const db = createDb({ connectionString: url })
    try {
      await grant(db, {
        workspaceId,
        source: 'admin',
        sourceRef: `workspace-private-reference:${workspaceId}`,
        amount: 100,
      })
      const reservation = await hold(db, {
        workspaceId,
        userId: String(account.id),
        amount: 2,
        refType: 'ai_message',
        refId: usageRef,
      })
      await capture(db, { workspaceId, holdId: reservation.id, actualAmount: 2 })
    } finally {
      await db.$client.end()
    }
    await page.goto(`/app/${slug}/usage`)
    await expect(page.getByText('Your own credit activity is shown below.')).toBeVisible()
    await expect(page.getByText(`ai_message · ${usageRef}`)).toBeVisible()
    expect(await page.content()).not.toContain('workspace-private-reference')
    await expect(page.getByRole('heading', { name: 'Credit batches' })).toHaveCount(0)
    await page.goto(`/app/${slug}/billing`)
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Payment history' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Continue to checkout' })).toHaveCount(0)
  } finally {
    await sql.end()
  }
})
