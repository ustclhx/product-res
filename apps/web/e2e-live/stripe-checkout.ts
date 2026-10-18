import { expect, type Page } from '@playwright/test'

// Stripe 托管结账页的操作，供 10.1 与 staging 的 11.1 场景复用。
// 只用于测试模式：卡号为 Stripe 官方测试卡，服务端运行时也只接受 sk_test_ 密钥。
export const STRIPE_TEST_CARDS = {
  success: '4242 4242 4242 4242',
  declined: '4000 0000 0000 0002',
} as const

/**
 * 在账单页选择 Stripe 与匹配的报价并进入托管结账页。报价按正则匹配选项文字，
 * 因为套餐名来自 seed 数据（模板默认为 `Pro (template example)`），派生项目会改名。
 */
export async function startStripeCheckout(page: Page, slug: string, price: RegExp) {
  await page.goto(`/app/${slug}/billing`)
  await page.getByLabel('Payment method').selectOption('stripe')
  const plan = page.getByLabel('Plan')
  const option = plan.locator('option', { hasText: price })
  await expect(option).toHaveCount(1)
  await plan.selectOption((await option.getAttribute('value')) ?? '')
  await page.getByRole('button', { name: 'Continue to checkout' }).click()
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 })
}

/** 在托管结账页用测试卡付款；字段因 Stripe 页面版本与地区而异，可选字段存在时才填写 */
export async function payOnStripeCheckout(
  page: Page,
  email: string,
  card: string = STRIPE_TEST_CARDS.success,
) {
  // 已有 Stripe Customer 时邮箱只读展示、没有输入框；fill 会一直等到用例超时
  await page.getByPlaceholder('1234 1234 1234 1234').waitFor()
  const emailBox = page.getByRole('textbox', { name: 'Email' })
  if (await emailBox.isVisible().catch(() => false)) await emailBox.fill(email)
  await page.getByPlaceholder('1234 1234 1234 1234').fill(card)
  await page.getByPlaceholder('MM / YY').fill('12 / 34')
  await page.getByPlaceholder('CVC').fill('123')
  await page
    .getByLabel(/name on card|cardholder name/i)
    .fill('E2E Tester')
    .catch(() => {})
  const zip = page.getByPlaceholder(/ZIP|Postal/i)
  if (await zip.isVisible().catch(() => false)) await zip.fill('94103')
  // Link「保存信息」默认勾选时要求手机号，测试中取消勾选
  const saveInfo = page.getByRole('checkbox', { name: /Save my information/i })
  if (await saveInfo.isChecked().catch(() => false)) await saveInfo.uncheck()
  await page.getByTestId('hosted-payment-submit-button').click()
}

/** 付款后回到应用的结账回跳页 */
export async function expectBillingReturn(page: Page, slug: string) {
  await page.waitForURL(new RegExp(`/app/${slug}/billing-return`), { timeout: 90_000 })
  await expect(page).toHaveURL(new RegExp(`/app/${slug}/billing-return`))
}
