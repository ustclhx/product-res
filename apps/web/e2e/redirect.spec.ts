import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { stubTurnstile } from './turnstile.ts'

const invitation = '/accept-invitation?id=01900000-0000-7000-8000-000000000001'
for (const redirect of [
  invitation,
  'https://evil.example',
  '//evil.example',
  `${invitation}&next=https://evil.example`,
]) {
  test(`OAuth initiation validates callback destination: ${redirect}`, async ({ page }) => {
    test.skip(!templateConfig.auth.oauth.includes('google'))
    await stubTurnstile(page)
    // Only the external provider exchange is mocked; no claim of provider verification.
    let callback = ''
    await page.route('**/api/auth/sign-in/social', async (route) => {
      callback = route.request().postDataJSON().callbackURL
      await route.fulfill({ json: { url: '/login?error=ACCESS_DENIED' } })
    })
    await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`)
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(page).toHaveURL(/error=ACCESS_DENIED/)
    expect(callback).toBe(redirect === invitation ? invitation : '/app')
  })
}

test('magic-link initiation resumes the validated invitation', async ({ page }) => {
  test.skip(!templateConfig.auth.magicLink)
  await stubTurnstile(page)
  let callback = ''
  await page.route('**/api/auth/sign-in/magic-link', async (route) => {
    callback = route.request().postDataJSON().callbackURL
    await route.fulfill({ json: { status: true } })
  })
  await page.goto(`/login?redirect=${encodeURIComponent(invitation)}`)
  await page.getByRole('button', { name: 'Sign in with magic link' }).click()
  await page.getByLabel('Email', { exact: true }).fill('callback@example.com')
  await page.getByRole('button', { name: 'Send magic link' }).click()
  await expect(page.getByRole('status')).toContainText('Check callback@example.com')
  expect(callback).toBe(invitation)
})
