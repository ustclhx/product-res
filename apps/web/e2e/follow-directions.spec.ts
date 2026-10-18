import { expect, test } from '@playwright/test'
import { register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-follow-selection 2.2 / 2.3：从跟卖选品入口进入方向页，新建方向并添加种子店铺；设置页的标签页增删。
test('选品方向与店铺池、设置页的节点日历与品牌库', async ({ page }) => {
  // 首次访问新页面时 vite dev 需要编译，放宽超时
  test.setTimeout(120_000)
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `follow-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')

  await page.goto(`${base}/follow`)
  await page.waitForLoadState('networkidle')
  await page.getByTestId('follow-directions-link').click()
  await expect(page).toHaveURL(new RegExp(`${base}/follow/directions$`))
  await expect(page.getByText('还没有选品方向')).toBeVisible()
  await expect(page.getByTestId('direction-card')).toHaveCount(0)
  // 等待水合完成再交互
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: '新建方向' }).click()
  const form = page.getByRole('form', { name: '选品方向' })
  await form.getByLabel('方向名称').fill('厨房收纳')
  await form.getByLabel('eBay US').check()
  await form.getByLabel('类目 ID').fill('20625, 20626')
  await form.getByLabel('关键词').fill('spice rack\ndrawer organizer')
  await form.getByLabel('返校季').check()
  await form.getByRole('button', { name: '保存' }).click()

  const card = page.getByTestId('direction-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByText('厨房收纳')).toBeVisible()
  await expect(card.getByText('启用中')).toBeVisible()
  await expect(card.getByText('20625、20626')).toBeVisible()
  await expect(card.getByText('返校季')).toBeVisible()

  const seed = card.getByRole('form', { name: '为厨房收纳添加种子店铺' })
  await seed.getByLabel('卖家 ID').fill('kitchen_pro')
  await seed.getByRole('button', { name: '添加种子店铺' }).click()
  await expect(card.getByText('对标店铺池（1）')).toBeVisible()
  await expect(card.getByText('kitchen_pro')).toBeVisible()

  await card.getByRole('button', { name: '停用' }).click()
  await expect(card.getByText('已停用')).toBeVisible()

  await page.goto(`${base}/config`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('tab', { name: '节点日历' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('cell', { name: /黑五\/网一/ })).toBeVisible()
  await page.getByRole('tab', { name: '品牌库' }).click()
  await expect(page.getByText('品牌库为空')).toBeVisible()
  await page.getByRole('button', { name: '新增条目' }).click()
  const brand = page.getByRole('form', { name: '品牌库条目' })
  await brand.getByLabel('品牌名').fill('Acme')
  await brand.getByLabel('类型').selectOption('vero')
  await brand.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: 'Acme' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'VeRO 权利人' })).toBeVisible()
  await page.getByRole('tab', { name: '物流与成本' }).click()
  await expect(page.getByText(/后续开放/)).toBeVisible()
})
