/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test'

// 主题切换（openspec add-marketing-i18n-seo tasks.md 2.1）：浅色 / 深色 / 跟随系统三种模式可切换、
// 刷新后保留；首帧即为所选主题，没有先浅后深的闪烁。

const html = (page: Page) => page.locator('html')
const option = (page: Page, value: string) => page.locator(`[data-theme-option="${value}"]`)

/** 截图中心像素的亮度（0–255）：在页面内用 canvas 解码截图 */
async function screenshotLuminance(page: Page) {
  const png = await page.screenshot()
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas 2d context unavailable')
    context.drawImage(bitmap, 0, 0)
    // 取左下角的空白像素，避开左上的文字与右下角的切换按钮
    const [r = 0, g = 0, b = 0] = context.getImageData(4, bitmap.height - 4, 1, 1).data
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }, png.toString('base64'))
}

test('三种模式可切换并在刷新后保留', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(option(page, 'system')).toHaveAttribute('aria-pressed', 'true')
  await expect(html(page)).not.toHaveClass(/\bdark\b/)

  await option(page, 'dark').click()
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await page.reload()
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await expect(option(page, 'dark')).toHaveAttribute('aria-pressed', 'true')

  // 浅色偏好优先于系统深色
  await page.emulateMedia({ colorScheme: 'dark' })
  await option(page, 'light').click()
  await expect(html(page)).not.toHaveClass(/\bdark\b/)
  await page.reload()
  await expect(html(page)).not.toHaveClass(/\bdark\b/)
  await expect(option(page, 'light')).toHaveAttribute('aria-pressed', 'true')

  // 跟随系统：随系统设置变化
  await option(page, 'system').click()
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).not.toHaveClass(/\bdark\b/)
  await page.reload()
  await expect(option(page, 'system')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull()
})

// 首帧：拦截全部外部脚本（应用打包产物不执行、不水合），页面只剩 SSR 输出与 <head> 中的内联脚本，
// 截图即刷新后浏览器最先绘制的画面。
for (const [name, setup] of [
  [
    '选择深色后刷新',
    async (page: Page) => {
      await page.emulateMedia({ colorScheme: 'light' })
      await page.goto('/')
      await option(page, 'dark').click()
      await expect(html(page)).toHaveClass(/\bdark\b/)
    },
  ],
  [
    '未设置偏好且系统为深色',
    async (page: Page) => {
      await page.emulateMedia({ colorScheme: 'dark' })
    },
  ],
] as const) {
  test(`首帧即为深色：${name}`, async ({ page }) => {
    await setup(page)
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'script' ? route.abort() : route.continue(),
    )
    await page.goto('/')
    await expect(html(page)).toHaveClass(/\bdark\b/)
    expect(await screenshotLuminance(page)).toBeLessThan(64)
  })
}

test('首帧为浅色：选择浅色后刷新（系统为深色）', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await option(page, 'light').click()
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'script' ? route.abort() : route.continue(),
  )
  await page.reload()
  await expect(html(page)).not.toHaveClass(/\bdark\b/)
  expect(await screenshotLuminance(page)).toBeGreaterThan(192)
})
