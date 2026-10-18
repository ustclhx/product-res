import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('管理员通过统一导航补发、收回指定批次，账务页保留空间筛选', async ({ page }) => {
  const sql = fixtureDb()
  const email = `admin-credits-${randomUUID()}@example.com`
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    const [workspace] =
      await sql`select organization_id as id from member where user_id=${account?.id} and role='owner' limit 1`
    if (!account || !workspace) throw new Error('Missing account fixture')
    await sql`update "user" set role='admin' where id=${account.id}`
    await page.goto(`/admin/credits?workspaceId=${workspace.id}`)
    await expect(page.getByRole('heading', { name: 'Credit adjustments' })).toBeVisible()
    await expect
      .poll(async () => {
        await page.getByLabel('Amount', { exact: true }).fill('')
        await page.getByLabel('Amount', { exact: true }).fill('25')
        await page.getByLabel('Reason', { exact: true }).fill('')
        await page.getByLabel('Reason', { exact: true }).fill('后台补偿测试')
        return page.getByRole('button', { name: 'Add credits', exact: true }).isEnabled()
      })
      .toBe(true)
    await page.getByRole('button', { name: 'Add credits', exact: true }).click()
    await expect(page.getByText('Adjustment applied.', { exact: true })).toBeVisible()
    const [batch] =
      await sql`select id from credit_grant where workspace_id=${workspace.id} and source='admin'`
    if (!batch) throw new Error('Missing adjustment batch')
    const row = page.getByRole('row').filter({ hasText: batch.id })
    await expect(row).toContainText('25 / 25')
    await page.getByLabel('Reason', { exact: true }).fill('撤回误发测试')
    page.once('dialog', (dialog) => dialog.accept())
    await row.getByRole('button', { name: 'Revoke batch' }).click()
    await expect(row).toContainText('revoked')
    await expect(row).toContainText('25 / 0')
    const [audit] =
      await sql`select count(*)::int as count from audit_log where workspace_id=${workspace.id} and action='credits.adjust'`
    expect(audit?.count).toBe(2)
    for (const [path, heading] of [
      ['/admin/billing/subscriptions', 'Subscriptions'],
      ['/admin/billing/purchases', 'One-time purchases'],
      ['/admin/billing/webhooks', 'Webhook events'],
    ] as const) {
      await page.goto(`${path}?workspaceId=${workspace.id}`)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page.getByLabel('Workspace ID', { exact: true })).toHaveValue(workspace.id)
    }
  } finally {
    await sql.end()
  }
})
