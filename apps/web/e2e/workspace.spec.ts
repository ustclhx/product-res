import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import {
  APP_URL,
  activateAccount,
  activateWorkspace,
  createTeamWorkspace,
  emailLink,
  fixtureDb,
  login,
  loginOtp,
  removeWorkspaceActivation,
  seedWorkspaceSeats,
  simulateClientIp,
  switchWorkspace,
  uiText,
  verifyInvitation,
  waitForHydration,
} from './fixtures.ts'
import { chooseOption } from './select.ts'
import { stubTurnstile } from './turnstile.ts'

const inviteForm = uiText('workspace_email_invite_title')

test('workspace creation, invitation entry and personal switching obey tenancy flag', async ({
  page,
}) => {
  // 多空间时本用例是完整旅程：两个账号注册、开通、多次重新登录、邀请、转让与移除成员，整页加载二十余次。
  // dev server 下远超 30 秒默认时限，此前表现为在重新登录处超时（#92）；单空间分支很快结束
  if (templateConfig.tenancy.multiTenant) test.setTimeout(240_000)
  await simulateClientIp(page)
  await stubTurnstile(page)
  await page.goto('/register')
  const form = page.getByRole('form', { name: uiText('auth_create_an_account') })
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await form.getByLabel(uiText('auth_name'), { exact: true }).fill('Workspace Owner')
  await form.getByLabel(uiText('auth_email'), { exact: true }).fill(`team-${key}@example.com`)
  await form.getByLabel(uiText('auth_password'), { exact: true }).fill('correct-horse-battery')
  await form.getByRole('button', { name: uiText('auth_create_account') }).click()
  await expect(page).toHaveURL(/\/app\/u-/)
  const personalUrl = page.url()
  const ownerEmail = `team-${key}@example.com`
  if (templateConfig.credits.requireGrantForAccess) await activateAccount(ownerEmail)
  await page.goto('/account')
  await waitForHydration(page)
  await page.getByRole('button', { name: uiText('account_verification_send') }).click()
  await expect(page.getByText(uiText('account_verification_sent'))).toBeVisible()
  await page.goto(await emailLink(ownerEmail))
  await expect(page.getByText(uiText('account_verification_verified'))).toBeVisible()
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await expect(page).toHaveURL(APP_URL)
  if (!templateConfig.tenancy.multiTenant) {
    await expect(page.getByTestId('workspace-menu')).toHaveCount(0)
    await page.getByRole('link', { name: uiText('app_workspace_settings') }).click()
    await expect(page.getByRole('form', { name: inviteForm })).toHaveCount(0)
    const sql = fixtureDb()
    const id = randomUUID()
    const slug = `readonly-${key}`
    try {
      const [owner] = await sql`select id from "user" where email = ${ownerEmail}`
      if (!owner) throw new Error('Registered owner missing from isolated database')
      await sql`insert into organization (id, name, slug, created_at, is_personal) values (${id}, 'Existing Team', ${slug}, now(), false)`
      await sql`insert into member (id, organization_id, user_id, role, created_at) values (${randomUUID()}, ${id}, ${owner.id}, 'owner', now())`
      await activateWorkspace(sql, id)
      await page.goto(`/app/${slug}/settings`)
      await expect(page.getByText(uiText('workspace_read_only'))).toBeVisible()
      await expect(page.getByRole('form', { name: inviteForm })).toHaveCount(0)
      await expect(page.getByTestId('workspace-menu')).toHaveCount(0)
      await page.goto('/account')
      await expect(
        page.getByRole('button', { name: uiText('account_profile_submit') }),
      ).toBeEnabled()
      await page.screenshot({ path: test.info().outputPath('tenancy-disabled.png') })
    } finally {
      await removeWorkspaceActivation(sql, id)
      await sql`delete from member where organization_id = ${id}`
      await sql`delete from organization where id = ${id}`
      await sql.end()
    }
    return
  }
  await createTeamWorkspace(page, 'Browser Team', `browser-${key}`)
  await seedWorkspaceSeats(`browser-${key}`)
  await page.getByRole('link', { name: uiText('app_workspace_settings') }).click()
  await page.getByLabel(uiText('workspace_invite_email')).fill(`invite-${key}@example.com`)
  let invitationId = ''
  await page.route('**/api/auth/organization/invite-member', async (route) => {
    const response = await route.fetch()
    const invitation = (await response.json()) as { id: string }
    invitationId = invitation.id
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: uiText('workspace_send_invite') }).click()
  await expect(page.getByText(`invite-${key}@example.com`, { exact: false })).toBeVisible()
  // 选品工作台固定使用 WorkbenchShell，经顶栏空间菜单切换（fixtures.ts 的 switchWorkspace）
  await switchWorkspace(page, 'Personal')
  await expect(page).toHaveURL(personalUrl)
  await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
  await page.goto(`/accept-invitation?id=${invitationId}`)
  await expect(page.getByRole('alert')).toHaveText(uiText('workspace_error_invitation_recipient'))
  await expect(page.getByText('Browser Team')).toHaveCount(0)
  await page.context().clearCookies()
  await page.goto('/register')
  const recipient = page.getByRole('form', { name: uiText('auth_create_an_account') })
  await recipient.getByLabel(uiText('auth_name'), { exact: true }).fill('Invited Member')
  await recipient
    .getByLabel(uiText('auth_email'), { exact: true })
    .fill(`invite-${key}@example.com`)
  await recipient.getByLabel(uiText('auth_password'), { exact: true }).fill('correct-horse-battery')
  await recipient.getByRole('button', { name: uiText('auth_create_account') }).click()
  await expect(page).toHaveURL(/\/app\/u-/)
  await page.context().clearCookies()
  await page.goto(`/accept-invitation?id=${invitationId}`)
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await login(page, `invite-${key}@example.com`, page.url())
  await expect(page).toHaveURL(new RegExp(`/accept-invitation\\?id=${invitationId}$`))
  await verifyInvitation(page, `invite-${key}@example.com`, invitationId, 'Browser Team')
  if (templateConfig.auth.emailOtp) {
    await page.context().clearCookies()
    await page.goto(`/accept-invitation?id=${invitationId}`)
    await expect(page).toHaveURL(/\/login\?redirect=/)
    await loginOtp(page, `invite-${key}@example.com`, page.url())
    await expect(page).toHaveURL(new RegExp(`/accept-invitation\\?id=${invitationId}$`))
  }
  await page.getByRole('button', { name: uiText('auth_accept_invitation') }).click()
  await expect(page).toHaveURL(new RegExp(`/app/browser-${key}$`))
  await page.getByRole('link', { name: uiText('app_workspace_settings') }).click()
  await expect(page.getByRole('form', { name: inviteForm })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: uiText('workspace_remove'), exact: true }),
  ).toHaveCount(0)
  const teamSettings = page.url()
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await page.goto(teamSettings)
  await chooseOption(
    page.getByRole('combobox', { name: uiText('workspace_role_for', { name: 'Invited Member' }) }),
    uiText('workspace_role_admin'),
  )
  const invited = page.getByRole('listitem').filter({ hasText: `invite-${key}@example.com` })
  const invitedRole = invited.locator('[data-slot="tag"]').first()
  await expect(invitedRole).toHaveText(uiText('workspace_role_admin'))
  await page.getByLabel(uiText('workspace_invite_email')).fill(`revoke-${key}@example.com`)
  await page.getByRole('button', { name: uiText('workspace_send_invite') }).click()
  const revoked = page.getByRole('listitem').filter({ hasText: `revoke-${key}@example.com` })
  await revoked.getByRole('button', { name: uiText('workspace_revoke_invitation') }).click()
  await expect(revoked).toContainText('canceled')
  let transferRequests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/organization/transfer-owner')) transferRequests += 1
  })
  const transferButton = page.getByRole('button', {
    name: uiText('workspace_transfer'),
    exact: true,
  })
  await transferButton.click()
  const transferDialog = page.getByRole('alertdialog', {
    name: uiText('workspace_transfer_confirm_title'),
  })
  await expect(transferDialog).toContainText(
    uiText('workspace_transfer_confirm_description', { name: 'Invited Member' }),
  )
  await transferDialog.getByRole('button', { name: uiText('common_cancel'), exact: true }).click()
  await expect(transferDialog).toHaveCount(0)
  await expect(transferButton).toBeFocused()
  expect(transferRequests).toBe(0)
  await page.reload()
  await expect(invitedRole).toHaveText(uiText('workspace_role_admin'))
  await transferButton.click()
  await transferDialog
    .getByRole('button', { name: uiText('workspace_transfer'), exact: true })
    .click()
  await expect(transferDialog).toHaveCount(0)
  expect(transferRequests).toBe(1)
  await expect(invitedRole).toHaveText(uiText('workspace_role_owner'))
  await expect(page.getByRole('button', { name: uiText('workspace_transfer') })).toHaveCount(0)
  await page.context().clearCookies()
  await simulateClientIp(page)
  if (templateConfig.auth.emailOtp) await loginOtp(page, `invite-${key}@example.com`)
  else await login(page, `invite-${key}@example.com`)
  await page.goto(teamSettings)
  const oldOwner = page.getByRole('listitem').filter({ hasText: ownerEmail })
  let removeRequests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/organization/remove-member')) removeRequests += 1
  })
  const removeButton = oldOwner.getByRole('button', {
    name: uiText('workspace_remove'),
    exact: true,
  })
  await removeButton.click()
  const removeDialog = page.getByRole('alertdialog', {
    name: uiText('workspace_remove_confirm_title'),
  })
  await expect(removeDialog).toContainText(
    uiText('workspace_remove_confirm_description', { name: 'Workspace Owner' }),
  )
  const removeCancel = removeDialog.getByRole('button', {
    name: uiText('common_cancel'),
    exact: true,
  })
  const removeConfirm = removeDialog.getByRole('button', {
    name: uiText('workspace_remove'),
    exact: true,
  })
  await removeCancel.click()
  await expect(removeDialog).toHaveCount(0)
  await expect(removeButton).toBeFocused()
  expect(removeRequests).toBe(0)
  await page.reload()
  await expect(oldOwner).toBeVisible()
  let releaseFailure = () => {}
  const heldFailure = new Promise<void>((resolve) => {
    releaseFailure = resolve
  })
  const removalUrl = '**/api/auth/organization/remove-member'
  await page.route(removalUrl, async (route) => {
    await heldFailure
    await route.fulfill({ status: 403, json: { code: 'WORKSPACE_PERMISSION' } })
  })
  await removeButton.click()
  await removeConfirm.click()
  await expect(removeCancel).toBeDisabled()
  await expect(removeConfirm).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(removeDialog).toBeVisible()
  releaseFailure()
  await expect(removeDialog).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveText(uiText('workspace_error_workspace_permission'))
  await expect(oldOwner).toBeVisible()
  expect(removeRequests).toBe(1)
  await page.unroute(removalUrl)
  await removeButton.click()
  await removeConfirm.click()
  await expect(removeDialog).toHaveCount(0)
  await expect(oldOwner).toHaveCount(0)
  expect(removeRequests).toBe(2)
  await page.screenshot({ path: test.info().outputPath('team-member-management.png') })
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await page.goto(teamSettings)
  await expect(page.getByRole('form', { name: inviteForm })).toHaveCount(0)
  await expect(page.getByText('Browser Team', { exact: true })).toHaveCount(0)
})
