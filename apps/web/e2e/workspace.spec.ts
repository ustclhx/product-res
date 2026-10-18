import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import {
  APP_URL,
  emailLink,
  fixtureDb,
  login,
  loginOtp,
  seedWorkspaceSeats,
  simulateClientIp,
  verifyInvitation,
} from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('workspace creation, invitation entry and personal switching obey tenancy flag', async ({
  page,
}) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await form.getByLabel('Name', { exact: true }).fill('Workspace Owner')
  await form.getByLabel('Email', { exact: true }).fill(`team-${key}@example.com`)
  await form.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/app\/u-/)
  const personalUrl = page.url()
  const ownerEmail = `team-${key}@example.com`
  await page.goto('/account')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Send verification email' }).click()
  await expect(
    page.getByText('Verification email sent. Check your inbox and open the link.'),
  ).toBeVisible()
  await page.goto(await emailLink(ownerEmail))
  await expect(page.getByText('Your email address is verified.')).toBeVisible()
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await expect(page).toHaveURL(APP_URL)
  if (!templateConfig.tenancy.multiTenant) {
    await expect(page.getByLabel('Switch workspace')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Create team workspace' })).toHaveCount(0)
    await page.getByRole('link', { name: 'Workspace settings' }).click()
    await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
    const sql = fixtureDb()
    const id = randomUUID()
    const slug = `readonly-${key}`
    try {
      const [owner] = await sql`select id from "user" where email = ${ownerEmail}`
      if (!owner) throw new Error('Registered owner missing from isolated database')
      await sql`insert into organization (id, name, slug, created_at, is_personal) values (${id}, 'Existing Team', ${slug}, now(), false)`
      await sql`insert into member (id, organization_id, user_id, role, created_at) values (${randomUUID()}, ${id}, ${owner.id}, 'owner', now())`
      await page.goto(`/app/${slug}/settings`)
      await expect(page.getByRole('status').last()).toHaveText(
        'Team features are disabled. This workspace is read-only.',
      )
      await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
      await expect(page.getByLabel('Switch workspace')).toHaveCount(0)
      await page.goto('/account')
      await expect(page.getByRole('button', { name: 'Save profile' })).toBeEnabled()
      await page.screenshot({ path: test.info().outputPath('tenancy-disabled.png') })
    } finally {
      await sql`delete from member where organization_id = ${id}`
      await sql`delete from organization where id = ${id}`
      await sql.end()
    }
    return
  }
  await page.getByRole('button', { name: 'Create team workspace' }).click()
  await page.getByLabel('Team name', { exact: true }).fill('Browser Team')
  await page.getByLabel('Workspace URL', { exact: true }).fill(`browser-${key}`)
  await page.getByRole('button', { name: 'Create team', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/app/browser-${key}$`))
  await seedWorkspaceSeats(`browser-${key}`)
  await page.getByRole('link', { name: 'Workspace settings' }).click()
  await page.getByLabel('Invite email').fill(`invite-${key}@example.com`)
  let invitationId = ''
  await page.route('**/api/auth/organization/invite-member', async (route) => {
    const response = await route.fetch()
    const invitation = (await response.json()) as { id: string }
    invitationId = invitation.id
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`invite-${key}@example.com`, { exact: false })).toBeVisible()
  await page.getByLabel('Switch workspace').selectOption({ label: 'Personal (personal)' })
  await expect(page).toHaveURL(personalUrl)
  await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
  await page.goto(`/accept-invitation?id=${invitationId}`)
  await expect(page.getByRole('alert')).toHaveText(
    'Sign in with the email address that received this invitation.',
  )
  await expect(page.getByText('Browser Team')).toHaveCount(0)
  await page.context().clearCookies()
  await page.goto('/register')
  const recipient = page.getByRole('form', { name: 'Create an account' })
  await recipient.getByLabel('Name', { exact: true }).fill('Invited Member')
  await recipient.getByLabel('Email', { exact: true }).fill(`invite-${key}@example.com`)
  await recipient.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await recipient.getByRole('button', { name: 'Create account' }).click()
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
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page).toHaveURL(new RegExp(`/app/browser-${key}$`))
  await page.getByRole('link', { name: 'Workspace settings' }).click()
  await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
  const teamSettings = page.url()
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await page.goto(teamSettings)
  await page.getByLabel('Role for Invited Member').selectOption('admin')
  await expect(
    page.getByText(`Invited Member (invite-${key}@example.com) · admin`, { exact: true }),
  ).toBeVisible()
  await page.getByLabel('Invite email').fill(`revoke-${key}@example.com`)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  const revoked = page.getByRole('listitem').filter({ hasText: `revoke-${key}@example.com` })
  await revoked.getByRole('button', { name: 'Revoke invitation' }).click()
  await expect(revoked).toContainText('canceled')
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Transfer ownership' }).click()
  await expect(
    page.getByText(`Invited Member (invite-${key}@example.com) · owner`, { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Transfer ownership' })).toHaveCount(0)
  await page.context().clearCookies()
  await simulateClientIp(page)
  if (templateConfig.auth.emailOtp) await loginOtp(page, `invite-${key}@example.com`)
  else await login(page, `invite-${key}@example.com`)
  await page.goto(teamSettings)
  const oldOwner = page.getByRole('listitem').filter({ hasText: ownerEmail })
  await oldOwner.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(oldOwner).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('team-member-management.png') })
  await page.context().clearCookies()
  await login(page, ownerEmail)
  await page.goto(teamSettings)
  await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
  await expect(page.getByText('Browser Team', { exact: true })).toHaveCount(0)
})
