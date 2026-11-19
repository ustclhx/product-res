/// <reference lib="dom" />
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { simulateClientIp } from './fixtures.ts'
import { chooseOption } from './select.ts'

// 每次访问 /dev/ui 都会加载分享卡片预览，按用例隔离真实限流桶。
test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
})

// 组件预览页（add-ui-design-system D6）：开发环境 wrangler 顶层设 UI_PREVIEW=true，页面可达且不被索引；
// 关闭时的 404 由 smoke.spec.ts（UI_PREVIEW=false）覆盖。
test('component preview renders every section in development', async ({ page }) => {
  const response = await page.goto('/dev/ui')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Component preview' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow')
  for (const name of [
    'Button',
    'Combobox',
    'Tabs',
    'Dropdown',
    'Command Menu',
    'Toast',
    'Sidebar',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }
  // 运行时切换预设写入 <html data-preset>
  await chooseOption(page.getByRole('combobox', { name: 'Preset', exact: true }), 'violet')
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'violet')
})

// 分享卡片预览（add-og-images 6.1）：中/英/长标题与默认分享图 × 浅/深，均由真实渲染器输出 1200×630。
test('share card previews render every variant at 1200x630', async ({ page }) => {
  await page.goto('/dev/ui#share-cards')
  const previews = page.locator('img[data-share-card-preview]')
  await expect(previews).toHaveCount(8)
  for (const variant of ['zh', 'en', 'long', 'default'])
    for (const mode of ['light', 'dark']) {
      const image = page.locator(`img[data-share-card-preview="${variant}-${mode}"]`)
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(
          () => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth),
          {
            timeout: 30_000,
          },
        )
        .toBe(1200)
      expect(await image.evaluate((node: HTMLImageElement) => node.naturalHeight)).toBe(630)
    }
})

// 对话组件一节（add-ai-chat-components 6.1、6.2）：断言只依赖 data-* 属性、ARIA 状态与元素结构，不依赖文案语言。
// 截图与 axe 结果写入证据目录（EVIDENCE_DIR，未设置时为已忽略的 test-results/evidence），与设计稿副本
// docs/design-system/prototypes/chat-components/States.dc.html 人工对照。
const chatEvidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'ai-chat-components',
)

async function openChatSection(page: Page) {
  await page.goto('/dev/ui#chat')
  const section = page.locator('#chat')
  // 本节懒加载：等到最后一个示例出现
  await expect(section.locator('[data-preview-width="388"]')).toBeVisible({ timeout: 30_000 })
  // 流式模拟开始推进说明本节已水合，之后的点击才会生效
  await expect
    .poll(() => section.locator('[data-stream-progress]').getAttribute('data-stream-progress'), {
      timeout: 30_000,
    })
    .not.toBe('0')
  return section
}

test('chat section shows every component state', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const chat = await openChatSection(page)

  // ChatMessage：两种角色 × 四种结束状态；流式中正文带光标标记与 aria-busy
  for (const role of ['user', 'assistant'])
    for (const status of ['aborted', 'incomplete', 'failed', 'retrying'])
      await expect(
        chat.locator(`[data-chat-role="${role}"] [data-chat-status="${status}"]`).first(),
      ).toBeVisible()
  const streaming = chat.locator('[data-chat-role="assistant"][data-status="streaming"]').first()
  await expect(streaming).toHaveAttribute('aria-busy', 'true')
  await expect(streaming.locator('[data-chat-streaming] [data-chat-tail]')).toHaveCount(1)
  await expect(chat.locator('[data-chat-role="user"][data-status="streaming"]')).toHaveCount(1)
  await expect(chat.locator('[data-thinking-indicator]')).toBeVisible()

  // ThinkingSteps：折叠 / 展开 / 进行中，按钮可切换
  const steps = (state: string) =>
    chat.locator(`[data-preview-steps="${state}"] [data-thinking-steps-trigger]`)
  await expect(steps('collapsed')).toHaveAttribute('aria-expanded', 'false')
  await expect(steps('expanded')).toHaveAttribute('aria-expanded', 'true')
  await expect(steps('busy')).toHaveAttribute('aria-expanded', 'true')
  await steps('collapsed').click()
  await expect(steps('collapsed')).toHaveAttribute('aria-expanded', 'true')

  // ToolCall：四态 + 通用名称；只有带详情的「已完成」有展开按钮
  await expect(chat.locator('[data-preview-tool]')).toHaveCount(5)
  for (const state of ['pending', 'running', 'error', 'generic'])
    await expect(chat.locator(`[data-preview-tool="${state}"] button`)).toHaveCount(0)
  const toolToggle = chat.locator('[data-preview-tool="done"] button')
  await expect(toolToggle).toHaveAttribute('aria-expanded', 'true')
  await toolToggle.click()
  await expect(toolToggle).toHaveAttribute('aria-expanded', 'false')

  // InputMessage 四态（最后一个按钮为发送 / 停止）
  const input = (state: string) => chat.locator(`[data-preview-input="${state}"]`)
  await expect(input('empty').locator('button').last()).toBeDisabled()
  expect(await input('multiline').locator('textarea').inputValue()).toContain('\n')
  await expect(input('busy')).toHaveAttribute('data-busy', 'true')
  await expect(input('busy').locator('button').last()).toBeEnabled()
  await expect(input('disabled').locator('textarea')).toBeDisabled()
  // 预览格是 flex-col flex-wrap：输入区高度等于内容高度，不被查询容器撑大
  for (const state of ['empty', 'multiline', 'busy', 'disabled']) {
    const heights = await input(state).evaluate((root) => ({
      root: (root as HTMLElement).offsetHeight,
      body: (root.querySelector('[data-input-message-body]') as HTMLElement).offsetHeight,
      parentWrap: getComputedStyle(root.parentElement as HTMLElement).flexWrap,
    }))
    expect(heights.parentWrap).toBe('wrap')
    expect(heights.root - heights.body).toBeLessThanOrEqual(2)
  }
  await input('empty').locator('textarea').fill('hello')
  await input('empty').locator('textarea').press('Enter')
  await expect(input('empty').locator('textarea')).toHaveValue('')

  // ChatMarkdown：危险内容不产生元素；外链带 rel；表格与代码块为可聚焦的滚动区域；复制不含语言名
  const safety = chat.locator('[data-preview-safety]')
  await expect(safety.locator('img, script, iframe')).toHaveCount(0)
  await expect(safety.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0)
  await expect(
    chat.locator('a[href^="https://product.ezarouter.cc/reports"]').first(),
  ).toHaveAttribute('rel', /noopener/)
  const table = chat.locator('[data-preview-table]')
  await expect(table.locator('table')).toHaveCount(1)
  await expect(table.locator('[role="group"][tabindex="0"]:has(table)')).toHaveCount(1)
  const code = table.locator('[data-chat-code]')
  await expect(code.locator('[role="group"][tabindex="0"]')).toHaveCount(1)
  await code.locator('button').click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.startsWith('def cac(')).toBe(true)

  // 流式模拟：暂停后不再增长，继续后播放到结束
  await chat.locator('[data-stream-control="pause"]').click()
  const progress = chat.locator('[data-stream-progress]')
  const paused = await progress.getAttribute('data-stream-progress')
  await page.waitForTimeout(400)
  await expect(progress).toHaveAttribute('data-stream-progress', paused ?? '')
  await expect(chat.locator('[data-preview-stream]')).toHaveAttribute('data-status', 'streaming')
  await chat.locator('[data-stream-control="resume"]').click()
  await expect(chat.locator('[data-stream-control="restart"]')).toBeVisible({ timeout: 30_000 })
  await expect(chat.locator('[data-preview-stream]')).not.toHaveAttribute('data-status', /./)
  await expect(chat.locator('[data-preview-stream] table')).toHaveCount(1)
})

// ChatMessage 的窄 / 宽版式按消息自身宽度切换（--container-chat-message = 23rem = 368px）
test('chat message layout switches at the 23rem container threshold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const chat = await openChatSection(page)
  const layout = (width: string) =>
    chat.locator(`[data-preview-width="${width}"]`).evaluate((box) => {
      const message = box.querySelector('[data-chat-role="assistant"]') as HTMLElement
      const rect = (selector: string) =>
        (box.querySelector(selector) as HTMLElement).getBoundingClientRect()
      const avatar = rect('[data-chat-avatar-cell]')
      const body = rect('[data-chat-body]')
      // 窄版式：正文通栏在头像行之下（左缘与头像对齐）；宽版式：正文在头像右侧的内容列
      return {
        width: message.offsetWidth,
        stacked: body.left <= avatar.left + 1 && body.top >= avatar.bottom,
      }
    })
  expect(await layout('358')).toEqual({ width: 358, stacked: true })
  expect(await layout('388')).toEqual({ width: 388, stacked: false })
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`chat section fits 390px and passes axe (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 390, height: 844 })
    const chat = await openChatSection(page)
    await expect(chat.locator('[data-stream-control="restart"]')).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    await mkdir(chatEvidenceDir, { recursive: true })
    await chat.screenshot({ path: resolve(chatEvidenceDir, `chat-390-${colorScheme}.png`) })
    await page.setViewportSize({ width: 1280, height: 900 })
    await chat.screenshot({ path: resolve(chatEvidenceDir, `chat-1280-${colorScheme}.png`) })
    await page
      .locator('#business-chat')
      .screenshot({ path: resolve(chatEvidenceDir, `business-chat-1280-${colorScheme}.png`) })

    // axe：对话组件一节与改用对话组件的嵌入式对话示例，桌面与 390px 各一次
    // 本节同时有多个表格与代码块（表格示例与流式模拟各一组）：滚动容器不能成为重名地标
    expect(await chat.locator('[data-chat-code]').count()).toBeGreaterThanOrEqual(2)
    expect(await chat.locator('table').count()).toBeGreaterThanOrEqual(2)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const results = await new AxeBuilder({ page })
        .include('#chat')
        .include('#business-chat')
        .analyze()
      await writeFile(
        resolve(chatEvidenceDir, `axe-${width}-${colorScheme}.json`),
        JSON.stringify(
          {
            url: page.url(),
            colorScheme,
            width,
            passes: results.passes.map((rule) => rule.id),
            violations: results.violations.map((rule) => ({
              id: rule.id,
              impact: rule.impact,
              nodes: rule.nodes.map((node) => ({
                target: node.target,
                summary: node.failureSummary,
              })),
            })),
          },
          null,
          2,
        ),
      )
      const relevant = results.violations
        .filter(
          (rule) =>
            rule.id === 'scrollable-region-focusable' ||
            rule.id === 'color-contrast' ||
            rule.id === 'landmark-unique' ||
            rule.id === 'region' ||
            rule.id.startsWith('aria-'),
        )
        .map((rule) => ({ id: rule.id, targets: rule.nodes.map((node) => node.target) }))
      expect(relevant).toEqual([])
    }
  })
}
