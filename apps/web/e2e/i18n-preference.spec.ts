import { expect, test } from '@playwright/test'
import { DUMMY_TURNSTILE_TOKEN } from './turnstile.ts'

const password = 'correct-horse-battery-staple'

test('Accept-Language 只建议不跳转，手动选择和关闭建议会记住偏好', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' },
  })
  const page = await context.newPage()
  try {
    await page.goto('/pricing')
    await expect(page).toHaveURL(/\/pricing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const banner = page.getByRole('complementary', { name: 'Language suggestion' })
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Switch language' }).click()
    await expect(page).toHaveURL(/\/zh\/pricing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'locale-preference')?.value,
    ).toBe('zh')
    // Cookie 记住选择，但直接访问默认语言 URL 仍显示默认语言。
    await page.goto('/pricing')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(banner).toHaveCount(0)
    await context.clearCookies()
    await page.reload()
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Keep current language' }).click()
    await page.reload()
    await expect(banner).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('换设备登录后应用区跟随账号语言，营销页继续按 URL，账号设置可再次切换', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const email = `i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const headers = { origin: baseURL ?? '', 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN }
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password, name: 'Locale User' },
  })
  expect(signup.status()).toBe(200)
  await page.goto('/app')
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh')
  await expect(page.getByText('个人空间', { exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')

  const other = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'en-US' })
  const secondPage = await other.newPage()
  try {
    // 新设备已有相反的匿名 Cookie，账号设置仍优先。
    await other.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: baseURL ?? '' }])
    const login = await other.request.post('/api/auth/sign-in/email', {
      headers,
      data: { email, password },
    })
    expect(login.status()).toBe(200)
    await secondPage.goto('/app')
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(secondPage.getByText('个人空间', { exact: true })).toBeVisible()
    await secondPage.goto('/pricing')
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'en')
    await secondPage.goto('/account')
    await expect(secondPage.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible()
    await expect(
      secondPage.getByRole('combobox', { name: '语言', exact: true }).first(),
    ).toBeEnabled()
    const preferences = secondPage
      .getByRole('heading', { name: '语言与时区', exact: true })
      .locator('..')
    await preferences.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
    await preferences.getByRole('button', { name: '保存偏好' }).click()
    // 现有账号设置表单保存后，账号和应用首屏均使用英文。
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'en')
    await secondPage.goto('/app')
    await expect(secondPage.getByText('Personal workspace', { exact: true })).toBeVisible()
  } finally {
    await other.close()
  }
})
