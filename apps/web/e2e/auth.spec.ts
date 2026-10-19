import { expect, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { activateAccount, simulateClientIp, uiText } from './fixtures.ts'
import { DUMMY_TURNSTILE_TOKEN, stubTurnstile } from './turnstile.ts'

/**
 * tasks.md 7.2 的 e2e：
 * - 登录页只显示模板配置中启用的登录方式（默认配置关闭魔法链接）；
 * - 注册 → 进入 /app；退出后用邮箱密码登录 → 进入 /app（个人空间）；
 * - 认证请求带 Turnstile 令牌，接口错误按错误码提示。
 */

const { auth } = templateConfig
const PASSWORD = 'correct-horse-battery'

/** 跳到 /app（p1-workspace 合并后会再重定向到 /app/<slug>） */
const APP_URL = /\/app\/u-[a-z0-9]+\/?$/
/** 内测准入：新注册账号先看到待开通页面 */
const gated = templateConfig.credits.requireGrantForAccess

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

function uniqueEmail() {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  const form = page.getByRole('form', { name: uiText('auth_sign_in_with_password') })
  await form.getByLabel(uiText('auth_email')).fill(email)
  await form.getByLabel(uiText('auth_password')).fill(password)
  // 拿到 Turnstile 令牌前提交按钮禁用；click 会等待按钮可用
  await form.getByRole('button', { name: uiText('auth_sign_in') }).click()
}

test('登录页只显示启用的登录方式', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: uiText('auth_sign_in') })).toBeVisible()

  const expectShown = async (name: string, shown: boolean) => {
    if (shown) await expect(page.getByRole('button', { name })).toBeVisible()
    else await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  // 默认首个启用的方式（邮箱密码）直接显示表单，其余方式为切换按钮
  await expect(page.getByRole('form', { name: uiText('auth_sign_in_with_password') })).toHaveCount(
    auth.emailPassword ? 1 : 0,
  )
  await expectShown(uiText('auth_sign_in_with_email_code'), auth.emailOtp)
  await expectShown(uiText('auth_sign_in_with_magic_link'), auth.magicLink)
  await expectShown(uiText('auth_continue_with_google'), auth.oauth.includes('google'))
  await expectShown(uiText('auth_continue_with_github'), auth.oauth.includes('github'))
  // 默认配置关闭魔法链接：页面中不出现任何魔法链接入口
  if (!auth.magicLink)
    await expect(page.getByText(uiText('auth_sign_in_with_magic_link'))).toHaveCount(0)

  if (auth.emailOtp) {
    await page.getByRole('button', { name: uiText('auth_sign_in_with_email_code') }).click()
    const otp = page.getByRole('form', { name: uiText('auth_sign_in_with_email_code') })
    await expect(otp.getByRole('button', { name: uiText('auth_send_code') })).toBeVisible()
  }
})

test('注册 → 进入 /app；退出后登录 → 进入 /app', async ({ page, context }) => {
  test.skip(!auth.emailPassword, '模板配置关闭了邮箱密码')
  test.skip(auth.requireEmailVerification, '强制验证邮箱时注册后需先验证，见 8.1 的完整流程')
  const email = uniqueEmail()

  await page.goto('/register')
  const form = page.getByRole('form', { name: uiText('auth_create_an_account') })
  await form.getByLabel(uiText('auth_name')).fill('E2E User')
  await form.getByLabel(uiText('auth_email')).fill(email)
  await form.getByLabel(uiText('auth_password')).fill(PASSWORD)
  const signUp = page.waitForRequest('**/api/auth/sign-up/email')
  await form.getByRole('button', { name: uiText('auth_create_account') }).click()
  const signUpHeaders = (await signUp).headers()
  if (auth.turnstile) {
    expect(signUpHeaders['x-turnstile-token']).toBeTruthy()
    if (process.env.E2E_REAL_TURNSTILE !== '1') {
      expect(signUpHeaders['x-turnstile-token']).toBe(DUMMY_TURNSTILE_TOKEN)
    }
  }
  await expect(page).toHaveURL(APP_URL)
  if (gated) {
    await expect(
      page.getByRole('heading', { level: 1, name: uiText('app_account_pending_title') }),
    ).toBeVisible()
    await activateAccount(email)
    await page.reload()
  }
  await expect(page.getByTestId('current-user')).toContainText(email)
  await expect(page.getByText(uiText('app_personal_workspace'), { exact: true })).toBeVisible()

  // 已登录：会话 Cookie 存在
  const cookies = await context.cookies()
  expect(cookies.some((c) => c.name.endsWith('session_token'))).toBe(true)

  await context.clearCookies()
  await signIn(page, email, PASSWORD)
  await expect(page).toHaveURL(APP_URL)
  await expect(page.getByTestId('current-user')).toContainText(email)
  await expect(page.getByText(uiText('app_personal_workspace'), { exact: true })).toBeVisible()
})

test('注册表单：只显示已失焦字段的错误，修正后一次点击即可提交', async ({ page }) => {
  test.skip(!auth.emailPassword, '模板配置关闭了邮箱密码')
  test.skip(auth.requireEmailVerification, '强制验证邮箱时注册后需先验证')
  await page.goto('/register')
  const form = page.getByRole('form', { name: uiText('auth_create_an_account') })
  const password = form.getByLabel(uiText('auth_password'))

  // 只编辑 Name 并失焦：未触碰的 Email / Password 不显示错误
  await form.getByLabel(uiText('auth_name')).fill('E2E User')
  await form.getByLabel(uiText('auth_name')).blur()
  // 在密码框输入（尚未失焦）时不提前显示它自己的错误
  await password.fill('short')
  await expect(form.getByText(uiText('auth_enter_a_valid_email_address'))).toHaveCount(0)
  await expect(form.getByText(uiText('auth_password_must_be_at_least_8_characters'))).toHaveCount(0)

  // 密码框失焦后才显示自己的错误
  await password.blur()
  await expect(form.getByText(uiText('auth_password_must_be_at_least_8_characters'))).toBeVisible()
  await expect(form.getByText(uiText('auth_enter_a_valid_email_address'))).toHaveCount(0)

  await form.getByLabel(uiText('auth_email')).fill(uniqueEmail())
  await password.fill(PASSWORD)
  // 修正后错误在输入时即消失，失焦不会再挪动提交按钮
  await expect(form.getByText(uiText('auth_password_must_be_at_least_8_characters'))).toHaveCount(0)
  const signUp = page.waitForRequest('**/api/auth/sign-up/email', { timeout: 10_000 })
  // 只点击一次，且点在按钮下沿附近：密码框仍有焦点，mousedown 触发的失焦若让错误消失、
  // 按钮上移，mouseup 会落到按钮外而丢失点击（中心点击可能因位移较小而侥幸命中）
  const submit = form.getByRole('button', { name: uiText('auth_create_account') })
  const box = await submit.boundingBox()
  if (!box) throw new Error('提交按钮不可见')
  await submit.click({ position: { x: box.width / 2, y: box.height - 3 } })
  await signUp
  await expect(page).toHaveURL(APP_URL)
  await expect(
    gated
      ? page.getByRole('heading', { level: 1, name: uiText('app_account_pending_title') })
      : page.getByText(uiText('app_personal_workspace'), { exact: true }),
  ).toBeVisible()
})

test('错误按错误码提示：密码错误', async ({ page }) => {
  test.skip(!auth.emailPassword, '模板配置关闭了邮箱密码')
  await signIn(page, uniqueEmail(), 'wrong-password-123')
  await expect(page.getByRole('alert')).toHaveText(uiText('auth_error_invalid_email_or_password'))
  await expect(page).toHaveURL(/\/login$/)
})

test('表单校验：非法输入不发请求', async ({ page }) => {
  await page.goto('/register')
  let requested = false
  page.on('request', (req) => {
    if (req.url().includes('/api/auth/sign-up')) requested = true
  })
  const form = page.getByRole('form', { name: uiText('auth_create_an_account') })
  await form.getByLabel(uiText('auth_email')).fill('not-an-email')
  await form.getByLabel(uiText('auth_password')).fill('short')
  await form.getByRole('button', { name: uiText('auth_create_account') }).click()
  await expect(form.getByText(uiText('auth_enter_your_name'))).toBeVisible()
  await expect(form.getByText(uiText('auth_enter_a_valid_email_address'))).toBeVisible()
  await expect(form.getByText(uiText('auth_password_must_be_at_least_8_characters'))).toBeVisible()
  expect(requested).toBe(false)
})

test('邮箱验证结果页与重置密码页按错误码提示', async ({ page }) => {
  await page.goto('/verify-email?error=TOKEN_EXPIRED')
  await expect(
    page.getByRole('heading', { name: uiText('auth_verification_failed') }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText(uiText('auth_error_token_expired'))

  await page.goto('/verify-email')
  await expect(page.getByRole('heading', { name: uiText('auth_email_verified') })).toBeVisible()

  await page.goto('/reset-password?error=INVALID_TOKEN')
  await expect(page.getByRole('alert')).toHaveText(uiText('auth_error_invalid_token'))
  await expect(page.getByRole('link', { name: uiText('auth_request_a_new_link') })).toBeVisible()
})
