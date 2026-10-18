import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createDb } from '@product-res/db'
import { loadEnv } from 'vite'
import { writeNotification } from '../src/features/notifications/service.ts'
import { adminText, fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('通用写入服务触发未读加一，点击跳转并归零，支持全部已读', async ({ page }) => {
  const sql = fixtureDb()
  const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
  const db = createDb({ connectionString: env.DATABASE_URL as string })
  const email = `notify-${randomUUID()}@example.com`
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const slug = new URL(page.url()).pathname.split('/')[2] as string
    const [account] = await sql`select id from "user" where email=${email}`
    const [workspace] = await sql`select id from organization where slug=${slug}`
    if (!account || !workspace) throw new Error('Notification fixture missing')
    await expect(page.getByTestId('notification-unread')).toHaveText('0')
    await writeNotification(db, workspace.id, {
      userId: account.id,
      type: 'test.completed',
      title: 'Fixture completed',
      link: `/app/${slug}/usage`,
    })
    await page.reload()
    await expect(page.getByTestId('notification-unread')).toHaveText('1')
    await page.getByLabel('通知（1 条未读）', { exact: true }).click()
    await page.getByRole('button', { name: 'Fixture completed' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${slug}/usage$`))
    await expect(page.getByTestId('notification-unread')).toHaveText('0')
    await writeNotification(db, workspace.id, {
      userId: account.id,
      type: 'test',
      title: 'Another notification',
    })
    await page.reload()
    await expect(page.getByTestId('notification-unread')).toHaveText('1')
    await page.getByLabel('通知（1 条未读）', { exact: true }).click()
    await page.getByRole('button', { name: '全部已读' }).click()
    await expect(page.getByTestId('notification-unread')).toHaveText('0')
  } finally {
    await db.$client.end()
    await sql.end()
  }
})

test('后台保存运营通知密钥后只显示配置状态，不回显明文', async ({ page }) => {
  const sql = fixtureDb()
  const keys = [
    'operations.telegramBotToken',
    'operations.telegramChatId',
    'operations.discordWebhookUrl',
  ]
  const original = await sql`select key,value from setting where key in ${sql(keys)}`
  const email = `ops-settings-${randomUUID()}@example.com`
  const token = '123456:abcdefghijklmnopqrstuvwxyz_fixture'
  const webhook = 'https://discord.com/api/webhooks/123456/fixture-secret'
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    await sql`update "user" set role='admin' where email=${email}`
    await page.goto('/admin/settings')
    const form = page.getByRole('form', { name: adminText('admin_operations_notifications') })
    await form.getByLabel(adminText('admin_telegram_bot_token'), { exact: true }).fill(token)
    await form.getByLabel(adminText('admin_telegram_chat_id'), { exact: true }).fill('-456')
    await form.getByLabel(adminText('admin_discord_webhook_url'), { exact: true }).fill(webhook)
    await form
      .getByRole('button', { name: adminText('admin_save_operations_notifications') })
      .click()
    await expect(form.getByRole('status')).toHaveText(adminText('admin_operations_settings_saved'))
    await expect(
      form.getByLabel(adminText('admin_telegram_bot_token'), { exact: true }),
    ).toHaveValue('')
    await expect(
      form.getByLabel(adminText('admin_discord_webhook_url'), { exact: true }),
    ).toHaveValue('')
    await page.reload()
    await expect(
      form.getByText(`${adminText('admin_telegram_bot')} ${adminText('admin_configured')}`),
    ).toBeVisible()
    await expect(
      form.getByText(`${adminText('admin_discord_webhook')} ${adminText('admin_configured')}`),
    ).toBeVisible()
    await expect(form.getByLabel(adminText('admin_telegram_chat_id'), { exact: true })).toHaveValue(
      '-456',
    )
    expect(await page.content()).not.toContain(token)
    expect(await page.content()).not.toContain(webhook)
  } finally {
    await sql`delete from setting where key in ${sql(keys)}`
    for (const row of original)
      await sql`insert into setting (id,key,value) values (${randomUUID()},${row.key},${JSON.stringify(row.value)}::jsonb)`
    await sql.end()
  }
})
