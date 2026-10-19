import { expect, test } from '@playwright/test'
import { register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-costing-decisions 2.2 / 3.2 / 4.1：设置页物流方案与成本参数（类目回退），工作台首页与档案库的空状态。
test('物流方案与成本参数、工作台首页与选品档案库', async ({ page }) => {
  test.setTimeout(120_000)
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `costing-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')

  await page.goto(base)
  await waitForHydration(page)
  await expect(page.getByText('没有待决定的线索')).toBeVisible()
  await expect(page.getByText('今天还没有额度记录')).toBeVisible()

  await page.goto(`${base}/config`)
  await waitForHydration(page)
  await page.getByRole('tab', { name: '物流方案' }).click()
  await page.getByRole('button', { name: '新增方案' }).click()
  const profile = page.getByRole('form', { name: '物流方案' })
  await profile.getByLabel('方案名称').fill('云途专线')
  await profile.getByLabel('首重价格').fill('30')
  await profile.getByLabel('续重价格').fill('15')
  await profile.getByLabel('计费方式').selectOption('volumetric')
  await profile.getByLabel('禁运属性').fill('battery')
  await profile.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: '云途专线' })).toBeVisible()
  await expect(page.getByText(/体积重系数 6000/)).toBeVisible()

  await page.getByRole('tab', { name: '成本参数' }).click()
  await page.getByRole('button', { name: '新增参数' }).click()
  let param = page.getByRole('form', { name: '成本参数' })
  await param.getByLabel('佣金率（%）').fill('15')
  await param.getByLabel('广告率（%）').fill('8')
  await param.getByRole('button', { name: '保存' }).click()
  await expect(page.getByTestId('cost-param-row')).toHaveCount(1)

  await page.getByRole('button', { name: '新增参数' }).click()
  param = page.getByRole('form', { name: '成本参数' })
  await param.getByLabel('类目 ID').fill('3760911')
  await param.getByLabel('佣金率（%）').fill('8')
  await param.getByRole('button', { name: '保存' }).click()
  const category = page.getByTestId('cost-param-row').filter({ hasText: '3760911' })
  await expect(category.getByText('8.0%').first()).toBeVisible()
  // 广告率没有单独填写，回退到平台默认并标注
  await expect(category.getByText('平台默认')).toHaveCount(1)

  await page.goto(`${base}/archive`)
  await waitForHydration(page)
  await expect(page.getByText('还没有已决定的线索')).toBeVisible()
  await expect(page.getByText('暂无品类研究报告')).toBeVisible()
})
