import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import {
  APP_URL,
  emailLink,
  fixtureDb,
  PASSWORD,
  register,
  seedWorkspaceSeats,
  simulateClientIp,
  verifyInvitation,
} from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

const key = () => `${Date.now()}-${randomUUID().slice(0, 8)}`

async function confirmAccountDeletion(page: Page) {
  await page.goto('/account')
  await page.waitForLoadState('networkidle')
  const button = page.getByRole('button', { name: 'Delete account', exact: true })
  await expect(button).toBeDisabled()
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await expect(button).toBeEnabled()
  await button.click()
}

async function expectWorkspaceMissing(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Workspace not found' })).toBeVisible()
  await expect(page.getByTestId('workspace-name')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
  }
})

test('account deletion rejects original cookies and password; same email creates a new identity', async ({
  page,
  context,
}) => {
  const email = `delete-${key()}@example.com`
  const sql = fixtureDb()
  try {
    await register(page, email)
    const originalUrl = page.url()
    const cookies = await context.cookies()
    expect(cookies.some((cookie) => cookie.name.endsWith('session_token'))).toBe(true)
    const [original] = await sql`select id from "user" where email = ${email}`
    if (!original) throw new Error('Registered user missing from isolated database')
    await confirmAccountDeletion(page)
    await expect(page).toHaveURL(/\/login$/)

    // Restore the actual pre-deletion cookie, including any signed cache cookie.
    for (const path of ['/app', new URL(originalUrl).pathname]) {
      await context.clearCookies()
      await context.addCookies(cookies)
      await page.goto(path)
      await page.reload()
      await expect(page).toHaveURL(/\/login(?:\?|$)/)
      await expect(page.getByTestId('workspace-name')).toHaveCount(0)
    }
    const [deleted] = await sql`select deleted_at from organization where id = ${original.id}`
    if (!deleted) throw new Error('Deleted personal workspace missing')
    expect(deleted.deleted_at).not.toBeNull()
    const memberships = await sql`select id from member where user_id = ${original.id}`
    expect(memberships).toHaveLength(0)

    await context.clearCookies()
    await page.goto('/login')
    const form = page.getByRole('form', { name: 'Sign in with password' })
    await form.getByLabel('Email', { exact: true }).fill(email)
    await form.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
    await expect(page).toHaveURL(/\/login$/)

    await register(page, email)
    await expect(page).toHaveURL(APP_URL)
    expect(page.url()).not.toBe(originalUrl)
    const [replacement] = await sql`select id from "user" where email = ${email}`
    if (!replacement) throw new Error('Re-registered user missing from isolated database')
    expect(replacement.id).not.toBe(original.id)
    await expectWorkspaceMissing(page, new URL(originalUrl).pathname)
  } finally {
    await sql.end()
  }
})

test('team deletion is owner-only, blocks sole-owner account deletion and revokes member access', async ({
  page,
  browser,
}) => {
  const suffix = key()
  const ownerEmail = `delete-owner-${suffix}@example.com`
  const memberEmail = `delete-member-${suffix}@example.com`
  const slug = `delete-${suffix}`
  const teamName = 'Deletion Browser Team'
  const sql = fixtureDb()
  await register(page, ownerEmail)
  if (!templateConfig.tenancy.multiTenant) {
    // An existing team remains readable when tenancy is disabled, but cannot be deleted.
    const id = randomUUID()
    try {
      const [owner] = await sql`select id from "user" where email = ${ownerEmail}`
      if (!owner) throw new Error('Registered owner missing from isolated database')
      await sql`insert into organization (id, name, slug, created_at, is_personal) values (${id}, ${teamName}, ${slug}, now(), false)`
      await sql`insert into member (id, organization_id, user_id, role, created_at) values (${randomUUID()}, ${id}, ${owner.id}, 'owner', now())`
      await page.goto(`/app/${slug}/settings`)
      await expect(page.getByRole('link', { name: 'Delete team workspace' })).toHaveCount(0)
      await expectWorkspaceMissing(page, `/app/${slug}/delete`)
    } finally {
      await sql`delete from member where organization_id = ${id}`
      await sql`delete from organization where id = ${id}`
      await sql.end()
    }
    return
  }
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  try {
    await page.goto('/account')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Send verification email' }).click()
    await expect(
      page.getByText('Verification email sent. Check your inbox and open the link.'),
    ).toBeVisible()
    await page.goto(await emailLink(ownerEmail))
    await expect(page.getByText('Your email address is verified.')).toBeVisible()
    await page.goto('/app')
    await page.getByRole('button', { name: 'Create team workspace' }).click()
    await page.getByLabel('Team name', { exact: true }).fill(teamName)
    await page.getByLabel('Workspace URL', { exact: true }).fill(slug)
    await page.getByRole('button', { name: 'Create team', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${slug}$`))
    await seedWorkspaceSeats(slug)
    await page.goto(`/app/${slug}/settings`)
    await page.getByLabel('Invite email').fill(memberEmail)
    await page.getByRole('button', { name: 'Send invitation' }).click()
    await expect(page.getByText(memberEmail, { exact: false })).toBeVisible()
    const [invitation] =
      await sql`select i.id from invitation i join organization o on o.id = i.organization_id where i.email = ${memberEmail} and o.slug = ${slug}`
    if (!invitation) throw new Error('UI-created invitation missing from isolated database')
    await stubTurnstile(memberPage)
    await simulateClientIp(memberPage)
    await register(memberPage, memberEmail, 'Deletion Member')
    await memberPage.goto(`/accept-invitation?id=${invitation.id}`)
    await verifyInvitation(memberPage, memberEmail, String(invitation.id), teamName)
    await memberPage.getByRole('button', { name: 'Accept invitation' }).click()
    await expect(memberPage).toHaveURL(new RegExp(`/app/${slug}$`))
    const memberCookies = await memberContext.cookies()
    await memberPage.goto(`/app/${slug}/settings`)
    await expect(memberPage.getByRole('link', { name: 'Delete team workspace' })).toHaveCount(0)
    await expectWorkspaceMissing(memberPage, `/app/${slug}/delete`)

    await confirmAccountDeletion(page)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: teamName })).toContainText(
      'transfer ownership or delete this team first.',
    )
    await page.goto(`/app/${slug}/delete`)
    await page.waitForLoadState('networkidle')
    const button = page.getByRole('button', { name: 'Delete workspace', exact: true })
    await expect(button).toBeDisabled()
    await page.getByLabel(`Type ${teamName} to confirm`).fill(teamName)
    await expect(button).toBeEnabled()
    await button.click()
    await expect(page).toHaveURL(APP_URL)
    await memberContext.clearCookies()
    await memberContext.addCookies(memberCookies)
    await expectWorkspaceMissing(memberPage, `/app/${slug}`)
    await confirmAccountDeletion(page)
    await expect(page).toHaveURL(/\/login$/)
  } finally {
    await memberContext.close()
    await sql.end()
  }
})
