import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import {
  createTeamWorkspace,
  PASSWORD,
  register,
  seedWorkspaceSeats,
  simulateClientIp,
  uiText,
} from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-team-invite-links 5.1：owner 生成链接 → 另一账号经链接注册 → 确认加入 → 看到团队空间。
test('owner shares an invite link, a new account registers through it and joins the team', async ({
  page,
  browser,
}) => {
  test.skip(!templateConfig.tenancy.multiTenant, 'invite links require team workspaces')
  test.setTimeout(90_000)
  const key = randomUUID().slice(0, 8)
  const slug = `links-${key}`
  const teamName = 'Invite Link Team'
  await stubTurnstile(page)
  await simulateClientIp(page)
  await register(page, `links-owner-${key}@example.com`, 'Link Owner')
  await createTeamWorkspace(page, teamName, slug)
  await seedWorkspaceSeats(slug)
  await page.getByRole('link', { name: uiText('app_workspace_settings') }).click()

  const form = page.getByRole('form', { name: uiText('invite_links_form') })
  await form.getByLabel(uiText('invite_links_role')).selectOption('member')
  await form.getByLabel(uiText('invite_links_ttl')).selectOption('7')
  await form.getByLabel(uiText('invite_links_max_uses')).fill('2')
  await form.getByRole('button', { name: uiText('invite_links_generate') }).click()
  await expect(page.getByText(uiText('invite_links_created'))).toBeVisible()
  const url = await page.getByLabel(uiText('invite_links_url')).inputValue()
  expect(url).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/)
  const row = page.getByTestId('invite-link-row').first()
  await expect(row).toContainText(uiText('invite_links_status_active'))
  await expect(row).toContainText('0 / 2')

  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  try {
    await stubTurnstile(guest)
    await simulateClientIp(guest)
    // 未登录：不显示空间名，先注册，注册后回到链接
    await guest.goto(url)
    await expect(guest.getByText(uiText('join_signed_out'))).toBeVisible()
    await expect(guest.getByText(teamName)).toHaveCount(0)
    await guest.getByRole('link', { name: uiText('join_register') }).click()
    await expect(guest).toHaveURL(/\/register\?redirect=%2Fjoin%2F/)
    const signup = guest.getByRole('form', { name: uiText('auth_create_an_account') })
    await signup.getByLabel(uiText('auth_name'), { exact: true }).fill('Link Guest')
    await signup
      .getByLabel(uiText('auth_email'), { exact: true })
      .fill(`links-guest-${key}@example.com`)
    await signup.getByLabel(uiText('auth_password'), { exact: true }).fill(PASSWORD)
    await signup.getByRole('button', { name: uiText('auth_create_account') }).click()
    await expect(guest).toHaveURL(url)
    await expect(
      guest.getByText(
        uiText('join_prompt', { workspace: teamName, role: uiText('workspace_role_member') }),
      ),
    ).toBeVisible()
    await guest.getByRole('button', { name: uiText('join_confirm') }).click()
    await expect(guest).toHaveURL(new RegExp(`/app/${slug}$`))
    await expect(guest.getByTestId('workspace-name')).toHaveText(teamName)
    await expect(guest.getByText(uiText('app_team_workspace'), { exact: true })).toBeVisible()
    // 已是成员：再次打开链接直接进入空间
    await guest.goto(url)
    await expect(guest).toHaveURL(new RegExp(`/app/${slug}$`))
    // member 看不到邀请链接管理
    await guest.goto(`/app/${slug}/settings`)
    await expect(guest.getByRole('form', { name: uiText('invite_links_form') })).toHaveCount(0)
  } finally {
    await guestContext.close()
  }

  await page.reload()
  await expect(row).toContainText('1 / 2')
  page.on('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: uiText('invite_links_revoke') }).click()
  await expect(row).toContainText(uiText('invite_links_status_revoked'))
  const members = page.getByRole('listitem').filter({ hasText: `links-guest-${key}@example.com` })
  await expect(members).toContainText(uiText('workspace_role_member'))
  await page.screenshot({ path: test.info().outputPath('invite-links.png'), fullPage: true })

  // 作废后：另一已登录账号打开链接看到明确提示
  const lateContext = await browser.newContext()
  const late = await lateContext.newPage()
  try {
    await stubTurnstile(late)
    await simulateClientIp(late)
    await register(late, `links-late-${key}@example.com`, 'Late Guest', { activate: false })
    await late.goto(url)
    await expect(late.getByRole('alert')).toHaveText(uiText('join_error_revoked'))
    await expect(late.getByRole('button', { name: uiText('join_confirm') })).toHaveCount(0)
  } finally {
    await lateContext.close()
  }
})
