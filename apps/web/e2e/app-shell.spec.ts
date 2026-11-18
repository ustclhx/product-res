/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 工作台侧边栏（openspec add-ui-design-system tasks 8.3）：两种 App 布局、折叠持久化、移动抽屉与 390px 无横向滚动。
// 布局取自 template.config.ts 的 ui.appLayout，构建期决定；两种布局分别在对应配置下运行本文件。

const sidebar = templateConfig.ui.appLayout === 'sidebar'

async function registerUser(page: Page) {
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `shell-${key}@example.com`, 'Shell Tester')
}

async function newUser(page: Page) {
  await registerUser(page)
  // 等待水合完成，侧边栏按钮的点击才会生效
  await page.waitForLoadState('networkidle')
  return page.url()
}

const shell = (page: Page) => page.locator('[data-slot="sidebar"]')
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' })

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('sidebar 布局', () => {
  test.skip(!sidebar, 'ui.appLayout 不是 sidebar')

  test('分组导航、当前项高亮与折叠状态刷新后保持', async ({ page }) => {
    // 注册加三次整页加载（含两次刷新），dev server 在并行负载下单页可达十秒，30 秒默认时限不够
    test.slow()
    await page.setViewportSize({ width: 1440, height: 900 })
    const home = await newUser(page)
    const workspaceNav = nav(page)
    await expect(workspaceNav.getByText('Tools', { exact: true })).toBeVisible()
    await expect(workspaceNav.getByText('Settings', { exact: true })).toBeVisible()
    await expect(workspaceNav.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await expect(page.getByTestId('current-user')).toContainText('Shell Tester')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home')
    // 还没有任何通知时不渲染通知块
    await expect(page.getByTestId('notification-unread')).toHaveCount(0)
    // 底部升级与账户入口
    await expect(page.getByRole('link', { name: 'View plans' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Account menu: Shell Tester' })).toBeVisible()

    await workspaceNav.getByRole('link', { name: 'Usage' }).click()
    await expect(page).toHaveURL(/\/usage$/)
    await expect(workspaceNav.getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(workspaceNav.getByRole('link', { name: 'Home' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
    // 顶部条标题即页面唯一的 h1，正文不再重复「Credit usage」标题
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usage')
    await expect(page.getByRole('heading', { name: 'Credit usage' })).toHaveCount(0)

    // 内容区：surface-2 圆角面板，与侧边栏之间 8px 外边距
    const inset = page.locator('[data-slot="sidebar-inset"]')
    const [panel, rail] = await Promise.all([inset.boundingBox(), shell(page).boundingBox()])
    expect(panel?.y).toBe(8)
    expect(Math.round(panel?.x ?? 0)).toBe(Math.round((rail?.width ?? 0) + (rail?.x ?? 0)))

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(shell(page)).toHaveAttribute('data-state', 'collapsed')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(64)
    // 收起后名称只给读屏，底部升级入口变为图标
    await expect(page.getByRole('link', { name: 'Upgrade your plan' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'View plans' })).toBeHidden()

    // 服务端首屏即按 cookie 输出收起状态（不依赖客户端修正）
    const html = await (await page.request.get(home)).text()
    expect(html).toMatch(/data-slot="sidebar"[^>]*data-state="collapsed"/)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(shell(page)).toHaveAttribute('data-state', 'collapsed')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(64)

    await page.getByRole('button', { name: 'Expand sidebar' }).first().click()
    await expect(shell(page)).toHaveAttribute('data-state', 'expanded')
    await page.reload()
    await expect(shell(page)).toHaveAttribute('data-state', 'expanded')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(248)

    // 打印只输出正文：侧边栏与顶部条隐藏，面板去掉外边距
    await page.emulateMedia({ media: 'print' })
    await expect(shell(page)).toBeHidden()
    await expect(page.getByTestId('app-page-title')).toBeHidden()
    expect((await page.locator('[data-slot="sidebar-inset"]').boundingBox())?.x).toBe(0)
    await page.emulateMedia({ media: 'screen' })
  })

  test('390px：抽屉打开、选择条目后关闭并把焦点还给菜单按钮，无横向滚动', async ({ page }) => {
    // 窄屏下直接注册，注册页提交也在回归范围内。本用例要整页加载注册页与 4 个应用页，
    // dev server 按模块逐个提供源码，并行负载下单页加载与水合可达数秒，30 秒默认时限不够
    test.slow()
    await page.setViewportSize({ width: 390, height: 844 })
    await registerUser(page)
    const menu = page.getByRole('button', { name: 'Open navigation' })
    // 移动端判定在水合后的 effect 中生效，此后菜单按钮才声明弹出抽屉对话框；之前的点击会落在
    // 尚未水合的按钮上而无效。networkidle 只代表网络空闲，不代表水合完成，不能作为点击前的等待条件
    const hydrated = () =>
      expect(menu).toHaveAttribute('aria-haspopup', 'dialog', { timeout: 30_000 })
    await hydrated()
    await expect(shell(page)).toBeHidden()
    await noHorizontalScroll(page)

    await menu.click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId('workspace-name')).toHaveText('Personal')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()

    await menu.click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('link', { name: 'Workspace settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspace settings')
    await noHorizontalScroll(page)

    const base = page.url().replace(/\/settings$/, '')
    for (const [path, title] of [
      ['usage', 'Usage'],
      ['billing', 'Billing'],
      ['chat', 'Chat'],
    ] as const) {
      await page.goto(`${base}/${path}`)
      // dev 页面会继续发起请求，不等 networkidle：等目标页标题与水合信号即可
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
      await hydrated()
      await expect(page.locator('[data-slot="sidebar-inset"]')).toBeVisible()
      await noHorizontalScroll(page)
    }
  })
})

test.describe('topbar 布局', () => {
  test.skip(sidebar, 'ui.appLayout 不是 topbar')

  test('沿用原有顶部布局，没有侧边栏', async ({ page }) => {
    await newUser(page)
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await expect(page.getByTestId('current-user')).toContainText('Shell Tester')
    await expect(shell(page)).toHaveCount(0)
    await page.getByRole('link', { name: 'Usage' }).click()
    await expect(page).toHaveURL(/\/usage$/)
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await page.setViewportSize({ width: 390, height: 844 })
    await noHorizontalScroll(page)
  })
})
