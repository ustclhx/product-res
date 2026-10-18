import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('runtime settings are hidden from non-admins', async ({ page }) => {
  await page.goto('/admin/settings')
  await expect(page.getByRole('heading', { name: 'Runtime settings' })).toHaveCount(0)
})

test('admin saves runtime settings, audits changes and displays a plain text announcement', async ({
  page,
}) => {
  const sql = fixtureDb()
  const email = `admin-settings-${randomUUID()}@example.com`
  const announcement = `Maintenance ${randomUUID()} <b>plain text</b>`
  let original: { signup: boolean; announcement: string; blacklist: string } | undefined
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing account fixture')
    await sql`update "user" set role='admin' where id=${account.id}`
    await page.goto('/admin/settings')
    await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible()
    const form = page.getByRole('form', { name: 'Runtime settings' })
    original = {
      signup: await form.getByLabel('Registration enabled').isChecked(),
      announcement: await form.getByLabel('Site announcement').inputValue(),
      blacklist: await form.getByLabel('Disposable email domains').inputValue(),
    }
    await form.getByLabel('Site announcement').fill(announcement)
    await form.getByLabel('Disposable email domains').fill('Mailinator.com\ntemp-mail.test')
    await form.getByLabel('Registration enabled').uncheck()
    await form.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Site announcement' })).toHaveText(announcement)
    expect(await sql`select value from setting where key='auth.signupEnabled'`).toEqual([
      { value: false },
    ])
    const audits =
      await sql`select meta from audit_log where action='setting.updated' and actor_user_id=${account.id} and target_id='auth.signupEnabled'`
    expect(audits).toEqual([
      { meta: { key: 'auth.signupEnabled', oldValue: original.signup, newValue: false } },
    ])
    await page.goto('/login')
    const banner = page.getByRole('status', { name: 'Site announcement' })
    await expect(banner).toHaveText(announcement)
    await expect(banner.locator('b')).toHaveCount(0)
  } finally {
    // 从同一后台入口恢复设置，同时失效 KV，避免污染后续认证场景。
    if (original) {
      await page.goto('/admin/settings')
      const form = page.getByRole('form', { name: 'Runtime settings' })
      await form.getByLabel('Registration enabled').setChecked(original.signup)
      await form.getByLabel('Site announcement').fill(original.announcement)
      await form.getByLabel('Disposable email domains').fill(original.blacklist)
      await form.getByRole('button', { name: 'Save settings' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    }
    await sql.end()
  }
})
