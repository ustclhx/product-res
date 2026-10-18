import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'
import { loadEnv } from 'vite'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('管理员查询审计分页与指标日期范围，页面显示数据截止时间', async ({ page }) => {
  const sql = fixtureDb()
  const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url))
  const local = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
  const migrator = (require('postgres') as (url: string) => typeof sql)(
    local.MIGRATION_DATABASE_URL ?? '',
  )
  const email = `audit-metrics-${randomUUID()}@example.com`
  const action = `test.page.${randomUUID()}`
  const days = ['2003-01-01', '2003-01-02']
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing admin fixture')
    await sql`update "user" set role='admin' where id=${account.id}`
    for (let i = 0; i < 51; i++)
      await sql`insert into audit_log (id,actor_user_id,workspace_id,action,created_at) values (${randomUUID()},${account.id},${account.id},${action},${new Date(Date.parse('2003-01-01T00:00:00Z') + i * 1000).toISOString()})`
    await sql`delete from metrics_daily where day in ${sql(days)}`
    for (const [index, day] of days.entries())
      await sql`insert into metrics_daily (day,registrations,total_users,total_workspaces,paid_workspaces,mrr_by_currency,credits_consumed,overage_absorbed,overage_by_model,text_completed,text_failed,text_aborted,data_through)
      values (${day},${index + 1},10,5,1,'{"USD":1200}',100,7,'{"test-model":7}',1,1,0,${new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString()})`
    await page.goto(
      `/admin/audit?actor=${account.id}&workspaceId=${account.id}&action=${action}&from=2003-01-01&to=2003-01-01`,
    )
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
    const audit = page.getByRole('table', { name: 'Audit log' })
    await expect(audit.locator('tbody tr')).toHaveCount(50)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(audit.locator('tbody tr')).toHaveCount(1)
    await expect(page).toHaveURL(/offset=50/)
    await page.goto('/admin/metrics?from=2003-01-01&to=2003-01-02')
    await expect(page.getByRole('heading', { name: 'Business metrics' })).toBeVisible()
    await expect(page.getByText(/Data through 2003-01-03T00:00:00.000Z/)).toBeVisible()
    await expect(page.getByText('test-model', { exact: true })).toBeVisible()
    await page.getByLabel('To (UTC)').fill('2003-01-01')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByText(/Data through 2003-01-02T00:00:00.000Z/)).toBeVisible()
  } finally {
    await migrator`delete from audit_log where action=${action}`
    await sql`delete from metrics_daily where day in ${sql(days)}`
    await migrator.end()
    await sql.end()
  }
})

test('非管理员无法打开审计和指标页面', async ({ page }) => {
  for (const path of ['/admin/audit', '/admin/metrics']) {
    await page.goto(path)
    await expect(
      page.getByRole('heading', {
        name: path.endsWith('audit') ? 'Audit log' : 'Business metrics',
      }),
    ).toHaveCount(0)
  }
})
