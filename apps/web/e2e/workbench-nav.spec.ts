import { expect, type Page, test } from '@playwright/test'
import { register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 工作台切 tab 的网络往返（docs/frontend-navigation.md）：
// - 工作空间页数据在客户端按 slug 短缓存，导航不再重取 getWorkspacePage；
// - 悬停 / 聚焦导航链接时预加载子路由 loader，点击后不再发请求。
const TABS = ['跟卖选品', '品牌选品', '店铺追踪', '选品档案库', '算法验证', '数据中心'] as const

/** 记录页面发出的 Server Function 请求（按 URL 中的函数名识别） */
function recordServerFns(page: Page) {
  const calls: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.includes('/_serverFn/')) calls.push(serverFnName(url))
  })
  return calls
}

/** 函数 id 是 base64url 编码的 {file, export}；解码失败时退回原始片段 */
function serverFnName(url: URL) {
  const id = url.pathname.split('/_serverFn/')[1]?.split('/')[0] ?? ''
  try {
    const decoded = Buffer.from(decodeURIComponent(id), 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as { export?: string }
    return (parsed.export ?? decoded).replace(/_createServerFn_handler$/, '')
  } catch {
    return id
  }
}

async function switchTo(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name })
  await link.click()
  await expect(link).toHaveAttribute('aria-current', 'page')
  // 等待路由加载完成（含后台重验证），避免把后续请求计入下一次切换
  await page.waitForFunction(() => {
    const router = (window as unknown as { __TSR_ROUTER__?: { state: { status: string } } })
      .__TSR_ROUTER__
    return !router || router.state.status === 'idle'
  })
  await page.waitForTimeout(300)
}

test('切 tab：不重取工作空间数据，悬停预加载后点击零请求', async ({ page }) => {
  test.setTimeout(120_000)
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `nav-${key}@example.com`)
  await waitForHydration(page)
  const calls = recordServerFns(page)

  // 1. 直接点击（Playwright 的 click 会先悬停，预加载与导航合并为同一次请求）
  const perSwitch: Array<{ tab: string; calls: string[] }> = []
  for (const tab of TABS) {
    const start = calls.length
    await switchTo(page, tab)
    perSwitch.push({ tab, calls: calls.slice(start) })
  }
  console.log('[workbench-nav] click', JSON.stringify(perSwitch))

  // 2. 整页刷新（清空客户端缓存，SSR 数据填充布局缓存）后，先悬停、等预加载完成再点击：
  // 预加载只取子路由数据，点击本身不发请求
  await page.reload()
  await waitForHydration(page)
  const hovered: Array<{ tab: string; preload: string[]; click: string[] }> = []
  for (const tab of ['跟卖选品', '品牌选品', '店铺追踪'] as const) {
    const link = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: tab })
    const before = calls.length
    await link.hover()
    await page.waitForTimeout(800)
    const mid = calls.length
    await switchTo(page, tab)
    hovered.push({ tab, preload: calls.slice(before, mid), click: calls.slice(mid) })
  }
  console.log('[workbench-nav] hover', JSON.stringify(hovered))

  const all = perSwitch.flatMap((s) => s.calls)
  expect(all.filter((name) => /getWorkspacePage/.test(name))).toEqual([])
  for (const s of perSwitch) expect(s.calls.length).toBeLessThanOrEqual(1)
  for (const h of hovered) {
    expect(h.preload).toHaveLength(1)
    expect(h.preload.filter((name) => /getWorkspacePage/.test(name))).toEqual([])
    expect(h.click).toEqual([])
  }
})
