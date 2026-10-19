import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp, uiText } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('runtime settings are hidden from non-admins', async ({ page }) => {
  await page.goto('/admin/settings')
  await expect(page.getByRole('heading', { name: uiText('admin_runtime_settings') })).toHaveCount(0)
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
    await expect(
      page.getByRole('heading', { name: uiText('admin_runtime_settings') }),
    ).toBeVisible()
    const form = page.getByRole('form', { name: uiText('admin_runtime_settings') })
    original = {
      signup: await form.getByLabel(uiText('admin_registration_enabled')).isChecked(),
      announcement: await form.getByLabel(uiText('admin_site_announcement')).inputValue(),
      blacklist: await form.getByLabel(uiText('admin_disposable_email_domains')).inputValue(),
    }
    await form.getByLabel(uiText('admin_site_announcement')).fill(announcement)
    await form
      .getByLabel(uiText('admin_disposable_email_domains'))
      .fill('Mailinator.com\ntemp-mail.test')
    await form.getByLabel(uiText('admin_registration_enabled')).uncheck()
    await form.getByRole('button', { name: uiText('admin_save_settings') }).click()
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: uiText('admin_saved_changes_apply_within_about_60_seconds') }),
    ).toBeVisible()
    await expect(page.getByRole('status', { name: uiText('admin_site_announcement') })).toHaveText(
      announcement,
    )
    expect(await sql`select value from setting where key='auth.signupEnabled'`).toEqual([
      { value: false },
    ])
    const audits =
      await sql`select meta from audit_log where action='setting.updated' and actor_user_id=${account.id} and target_id='auth.signupEnabled'`
    expect(audits).toEqual([
      { meta: { key: 'auth.signupEnabled', oldValue: original.signup, newValue: false } },
    ])
    await page.goto('/login')
    const banner = page.getByRole('status', { name: uiText('admin_site_announcement') })
    await expect(banner).toHaveText(announcement)
    await expect(banner.locator('b')).toHaveCount(0)
  } finally {
    // 从同一后台入口恢复设置，同时失效 KV，避免污染后续认证场景。
    if (original) {
      await page.goto('/admin/settings')
      const form = page.getByRole('form', { name: uiText('admin_runtime_settings') })
      await form.getByLabel(uiText('admin_registration_enabled')).setChecked(original.signup)
      await form.getByLabel(uiText('admin_site_announcement')).fill(original.announcement)
      await form.getByLabel(uiText('admin_disposable_email_domains')).fill(original.blacklist)
      await form.getByRole('button', { name: uiText('admin_save_settings') }).click()
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: uiText('admin_saved_changes_apply_within_about_60_seconds') }),
      ).toBeVisible()
    }
    await sql.end()
  }
})
