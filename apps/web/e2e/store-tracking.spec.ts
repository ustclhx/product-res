import { expect, test } from '@playwright/test'
import { register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-accuracy-store-tracking 3.4：从工作台导航进入店铺追踪，粘贴链接添加店铺（含无法识别的链接），
// 打开详情查看覆盖率说明与店铺指标，再暂停店铺。不触发任何外部采集。
test('店铺追踪：添加、详情与暂停', async ({ page }) => {
  test.setTimeout(120_000)
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const seller = `A${Date.now().toString(36).toUpperCase()}`
  await register(page, `stores-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')

  await page.goto(base)
  await waitForHydration(page)
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '店铺追踪' })
    .click()
  await expect(page).toHaveURL(new RegExp(`${base}/stores$`))
  await expect(page.getByRole('heading', { name: '店铺追踪', level: 1 })).toBeVisible()
  await expect(page.getByText('店铺池还是空的')).toBeVisible()
  await waitForHydration(page)

  const form = page.getByRole('form', { name: '添加店铺' })
  const link = form.getByLabel('店铺链接')
  // 商品详情链接：提示无法识别，不创建记录
  await link.fill('https://www.amazon.com/dp/B0C1234567')
  await link.blur()
  await expect(form.getByTestId('store-link-error')).toContainText('无法识别店铺')
  await form.getByRole('button', { name: '加入店铺池' }).click()
  await expect(form.getByRole('alert').last()).toContainText('无法识别店铺')
  await expect(page.getByText('店铺池还是空的')).toBeVisible()

  await link.fill(`https://www.amazon.com/sp?seller=${seller}`)
  await link.blur()
  await expect(form.getByTestId('store-link-parsed')).toContainText(`卖家 ${seller}`)
  await form.getByLabel('显示名').fill('Rack House')
  await form.getByLabel('搜索词（1–5 个）').fill('spice rack')
  await form.getByRole('button', { name: '加入店铺池' }).click()

  const table = page.getByRole('table', { name: '店铺池' })
  await expect(table.getByRole('link', { name: 'Rack House' })).toBeVisible()
  await expect(table.getByText(seller)).toBeVisible()
  await expect(table.getByText('跟卖对标')).toBeVisible()
  await expect(table.getByText('尚未同步')).toBeVisible()

  await table.getByRole('link', { name: 'Rack House' }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/stores/[0-9a-f-]+$`))
  await expect(page.getByRole('heading', { name: 'Rack House', level: 1 })).toBeVisible()
  await expect(page.getByTestId('store-coverage')).toContainText('关键词覆盖，不完整')
  await expect(page.getByTestId('store-coverage')).toContainText('搜索词：spice rack')
  await expect(page.getByTestId('store-metric').first()).toContainText('样本不足')
  await expect(page.getByText('还没有发现该店铺的商品')).toBeVisible()

  await page.getByRole('link', { name: '店铺追踪' }).first().click()
  await expect(page).toHaveURL(new RegExp(`${base}/stores$`))
  await waitForHydration(page)
  await page.getByRole('table', { name: '店铺池' }).getByRole('button', { name: '暂停' }).click()
  await expect(page.getByRole('table', { name: '店铺池' }).getByText('已暂停')).toBeVisible()
})
