import { expect, type Locator, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { SUGGESTABLE_LOCALES, suggestionTargets } from '../src/features/i18n/suggestion.ts'
import { chooseOption } from './select.ts'
import { DUMMY_TURNSTILE_TOKEN } from './turnstile.ts'

test.skip(!templateConfig.i18n.enabled, '模板配置关闭了多语言偏好')

const password = 'correct-horse-battery-staple'
// 拓宽为 string：衍生项目的语言集合不同，下面与模板语言的比较仍能通过类型检查
const { enabled } = templateConfig.i18n
const locales: readonly string[] = templateConfig.i18n.locales
const defaultLocale: string = templateConfig.i18n.defaultLocale
/** 被建议的语言：取配置中第一个可建议语言，浏览器偏好设为该语言即会建议它；没有时为空串，用例跳过 */
const target =
  (enabled &&
    suggestionTargets({
      baseLocale: defaultLocale,
      locales,
      suggestableLocales: SUGGESTABLE_LOCALES,
    })[0]) ||
  ''
const noTarget = '未启用多语言或没有可建议的非默认语言，不会出现语言建议横幅'

/**
 * 目标语言的建议横幅；用属性定位，不依赖默认语言的文案。
 * 每个候选横幅都随 SSR 输出（默认隐藏），只计可见的一条，toHaveCount(0) 即「没有显示横幅」
 */
const suggestionBanner = (page: Page) =>
  page.locator(`[data-locale-suggestion-for="${target}"]`).filter({ visible: true })
const switchLink = (banner: Locator) => banner.locator('[data-locale-suggestion-action="switch"]')
const keepButton = (banner: Locator) => banner.locator('[data-locale-suggestion-action="dismiss"]')

/** 水合完成的信号：横幅组件在挂载 effect 中加上 data-hydrated（不依赖浮动语言选择器） */
const hydrated = (banner: Locator) =>
  expect(banner).toHaveAttribute('data-hydrated', '', { timeout: 30_000 })

/** 「切换」链接的目标地址（由 localizeHref 生成，不假设语言前缀形式），可附加查询参数 */
const switchURL = async (page: Page, banner: Locator, suffix = '') =>
  new URL(`${await switchLink(banner).getAttribute('href')}${suffix}`, page.url()).href

/** 挂起页面脚本请求，模拟营销页首帧后、水合前的时间窗；返回放行函数 */
async function holdScripts(page: Page) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') await gate
    await route.fallback().catch(() => {})
  })
  return async () => {
    release()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
}

const preferenceCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === 'locale-preference')?.value

test('浏览器语言偏好只建议不跳转，手动选择和关闭建议会记住偏好', async ({ browser, baseURL }) => {
  test.skip(!target, noTarget)
  // 建议由首帧前脚本按 navigator.languages 决定（suggestion.ts），locale 同时设置它与 Accept-Language
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: target })
  const page = await context.newPage()
  try {
    await page.goto('/pricing')
    await expect(page).toHaveURL(/\/pricing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', defaultLocale)
    const banner = suggestionBanner(page)
    await expect(banner).toBeVisible()
    await hydrated(banner)
    const destination = await switchURL(page, banner)
    await switchLink(banner).click()
    await expect(page).toHaveURL(destination)
    await expect(page.locator('html')).toHaveAttribute('lang', target)
    expect(await preferenceCookie(page)).toBe(target)
    // Cookie 记住选择，但直接访问默认语言 URL 仍显示默认语言。
    await page.goto('/pricing')
    await expect(page.locator('html')).toHaveAttribute('lang', defaultLocale)
    await expect(banner).toHaveCount(0)
    await context.clearCookies()
    await page.reload()
    await expect(banner).toBeVisible()
    await hydrated(banner)
    await keepButton(banner).click()
    await expect(banner).toBeHidden()
    await page.reload()
    await expect(banner).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('横幅首帧即可操作：水合前点击切换与保留当前语言同样生效', async ({ browser, baseURL }) => {
  test.skip(!target, noTarget)
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: target })
  const page = await context.newPage()
  const banner = suggestionBanner(page)
  try {
    // 保留当前语言：首帧脚本的委托监听写入 Cookie 并隐藏横幅
    let release = await holdScripts(page)
    await page.goto('/pricing', { waitUntil: 'commit' })
    await expect(banner).toBeVisible()
    // 脚本被挂起，尚未水合
    await expect(banner).not.toHaveAttribute('data-hydrated')
    await keepButton(banner).click()
    await expect(banner).toBeHidden()
    expect(await preferenceCookie(page)).toBe(defaultLocale)
    await release()
    await page.reload()
    await expect(banner).toHaveCount(0)

    // 切换：真实链接直接导航，委托监听同时记住选择
    await context.clearCookies()
    release = await holdScripts(page)
    await page.goto('/pricing?utm_source=e2e', { waitUntil: 'commit' })
    await expect(banner).toBeVisible()
    await expect(banner).not.toHaveAttribute('data-hydrated')
    const destination = await switchURL(page, banner, '?utm_source=e2e')
    await switchLink(banner).click()
    // 查询参数（如 UTM）随导航保留
    await expect(page).toHaveURL(destination)
    await release()
    await expect(page.locator('html')).toHaveAttribute('lang', target)
    expect(await preferenceCookie(page)).toBe(target)
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
  // 本用例针对模板自带的 en / zh 文案（中文界面文字），衍生项目语言不同时跳过
  test.skip(
    !enabled || !locales.includes('zh') || defaultLocale !== 'en',
    '需要启用多语言且配置默认语言 en 与 zh：用例断言的是模板自带的中英文界面文字',
  )
  const email = `i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const headers = { origin: baseURL ?? '', 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN }
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password, name: 'Locale User' },
  })
  expect(signup.status()).toBe(200)
  await page.goto('/app')
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()
  await chooseOption(page.getByRole('combobox', { name: 'Language', exact: true }), '中文')
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
    await chooseOption(preferences.getByRole('combobox', { name: '语言', exact: true }), 'en')
    await preferences.getByRole('button', { name: '保存偏好' }).click()
    // 现有账号设置表单保存后，账号和应用首屏均使用英文。
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'en')
    await secondPage.goto('/app')
    await expect(secondPage.getByText('Personal workspace', { exact: true })).toBeVisible()
  } finally {
    await other.close()
  }
})
