import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { emailLink, fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('signup credits require email verification and repeat claims grant only once', async ({
  page,
}) => {
  test.skip(
    templateConfig.auth.requireEmailVerification,
    'This flow begins with an unverified session',
  )
  const email = `signup-${randomUUID()}@example.com`
  const sql = fixtureDb()
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing registered fixture')
    await page.goto('/account')
    await expect(
      page.getByRole('button', {
        name: `Verify email to claim ${templateConfig.billing.signupBonusCredits} credits`,
      }),
    ).toBeVisible()
    expect(
      await sql`select id from credit_grant where workspace_id=${account.id} and source='signup'`,
    ).toHaveLength(0)
    await page
      .getByRole('button', {
        name: `Verify email to claim ${templateConfig.billing.signupBonusCredits} credits`,
      })
      .click()
    await expect(
      page.getByText('Verification email sent. Your credits will be added after verification.'),
    ).toBeVisible()
    await page.goto(await emailLink(email))
    await expect(page).toHaveURL(/\/account\/?$/)
    await expect(
      page.getByRole('button', { name: 'Claim signup credits', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Claim signup credits', exact: true }).click()
    await expect(
      page.getByText('This email has already received its signup credits.'),
    ).toBeVisible()
    const grants =
      await sql`select amount from credit_grant where workspace_id=${account.id} and source='signup'`
    expect(grants).toEqual([{ amount: templateConfig.billing.signupBonusCredits }])
  } finally {
    await sql.end()
  }
})
