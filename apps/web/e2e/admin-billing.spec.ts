import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { capture, grant, hold } from '@product-res/credits'
import { createDb } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { fixtureDb, register, simulateClientIp, uiText } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('billing administration hides data from unauthenticated visitors', async ({ page }) => {
  await page.goto('/admin/billing')
  await expect(
    page.getByRole('heading', { name: uiText('admin_billing_administration') }),
  ).toHaveCount(0)
  await page.goto('/admin/billing/refunds')
  await expect(page.getByRole('heading', { name: uiText('admin_refund_reviews') })).toHaveCount(0)
})

test('fresh platform admin can list and reject without payment credentials', async ({ page }) => {
  const sql = fixtureDb()
  const email = `admin-billing-${randomUUID()}@example.com`
  const id = randomUUID()
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    await page.goto('/admin/billing/refunds')
    await expect(page.getByRole('heading', { name: uiText('admin_refund_reviews') })).toHaveCount(0)
    const [account] = await sql`select id from "user" where email=${email}`
    const [workspace] =
      await sql`select organization_id as id from member where user_id=${account?.id} and role='owner' limit 1`
    if (!account || !workspace) throw new Error('Missing account fixture')
    await sql`update "user" set role='admin' where id=${account.id}`
    const plan = randomUUID()
    const price = randomUUID()
    const purchase = randomUUID()
    const payment = randomUUID()
    await sql`insert into plan(id,key,name,type,credits,features) values(${plan},${plan},'Admin fixture','credit_pack',100,'{"models":[],"maxConcurrentTasks":1,"maxSeats":1,"storageGb":1,"publicApi":false,"priorityQueue":false,"watermark":true}'::jsonb)`
    await sql`insert into plan_price(id,plan_id,provider,provider_price_id,amount,currency) values(${price},${plan},'stripe',${price},1234,'USD')`
    await sql`insert into purchase(id,workspace_id,user_id,plan_id,plan_price_id,provider,provider_order_id,status,amount,currency) values(${purchase},${workspace.id},${account.id},${plan},${price},'stripe',${purchase},'paid',1234,'USD')`
    await sql`insert into payment(id,workspace_id,provider,provider_payment_id,purchase_id,kind,amount,currency,paid_at) values(${payment},${workspace.id},'stripe',${payment},${purchase},'one_time',1234,'USD',now())`
    await sql`insert into refund_request(id,workspace_id,user_id,payment_id,reason,contact_email,requested_amount) values(${id},${workspace.id},${account.id},${payment},'Fixture refund request',${email},500)`
    const url = readLocalEnv('DATABASE_URL')
    if (!url) throw new Error('Missing isolated worktree database')
    const db = createDb({ connectionString: url })
    try {
      await grant(db, {
        workspaceId: String(workspace.id),
        source: 'purchase',
        sourceRef: payment,
        paymentId: payment,
        amount: 100,
      })
      const reserved = await hold(db, {
        workspaceId: String(workspace.id),
        userId: String(account.id),
        amount: 40,
        refType: 'ai_message',
        refId: randomUUID(),
      })
      await capture(db, {
        workspaceId: String(workspace.id),
        holdId: reserved.id,
        actualAmount: 40,
      })
    } finally {
      await db.$client.end()
    }
    await page.goto('/admin/billing/refunds')
    const card = page.getByRole('article', { name: uiText('admin_refund', { id }) })
    await expect(card).toContainText(`${uiText('admin_requested')} $5.00`)
    await expect(card).toContainText(
      `${uiText('admin_original_credits')} 100 ${uiText('admin_remaining_credits')} 60`,
    )
    await expect
      .poll(async () => {
        await card.getByLabel(uiText('admin_review_note_field')).fill('')
        await card
          .getByLabel(uiText('admin_review_note_field'))
          .fill('Fixture rejected by reviewer')
        return card.getByRole('button', { name: uiText('admin_reject_refund') }).isEnabled()
      })
      .toBe(true)
    await card.getByRole('button', { name: uiText('admin_reject_refund') }).click()
    await expect(card).toContainText(`${uiText('admin_status_inline')} rejected`)
    const [saved] =
      await sql`select status,reviewer_id,requested_amount,reason from refund_request where id=${id}`
    expect(saved).toMatchObject({
      status: 'rejected',
      reviewer_id: account.id,
      requested_amount: 500,
      reason: 'Fixture refund request',
    })
    await page.goto('/admin/billing')
    await expect(
      page.getByRole('heading', { name: uiText('admin_billing_administration') }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: workspace.id })
        .getByRole('cell', { name: '$12.34', exact: true }),
    ).toBeVisible()
    await sql`update "user" set role='user' where id=${account.id}`
    await page.reload()
    await expect(
      page.getByRole('heading', { name: uiText('admin_billing_administration') }),
    ).toHaveCount(0)
  } finally {
    await sql.end()
  }
})
