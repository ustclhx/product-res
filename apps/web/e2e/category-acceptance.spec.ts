import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { categoryFixture } from '../test/fixtures/category-insight-data.ts'
import { fixtureDb, register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-category-insight 4.1 验收：夹具市场数据 → 新建品类研究 → 报告 → 竞品矩阵转线索
// → 跟卖候选列表可见（跟卖方式同款微改良）→ 归档后在选品档案库可见。
// 与 category-insight.spec.ts 分开：本条只走验收主链路，截图放 docs/receipts/m4-acceptance-<日期>/。
const now = new Date()
const day = now.toLocaleDateString('sv-SE')
const receipts = new URL(`../../../docs/receipts/m4-acceptance-${day}/`, import.meta.url).pathname

async function seed(slug: string, suffix: string) {
  const fx = categoryFixture(now, suffix)
  const sql = fixtureDb()
  try {
    const [ws] = await sql`select id from organization where slug = ${slug}`
    if (!ws) throw new Error('workspace missing')
    const ids = new Map<string, string>()
    for (const p of fx.products) {
      const [row] = await sql`insert into marketplace_product
        (id, marketplace, platform_id, title, brand, category_id, url, listed_at, first_seen_at)
        values (gen_random_uuid(), 'amazon-us', ${p.platformId}, ${p.title}, ${p.brand}, ${fx.categoryId},
          ${`https://www.amazon.com/dp/${p.platformId}`}, ${p.listedAt}, '2025-01-01T00:00:00Z')
        returning id`
      ids.set(p.platformId, row?.id as string)
    }
    const [kw] = await sql`insert into marketplace_keyword (id, marketplace, phrase)
      values (gen_random_uuid(), 'amazon-us', ${fx.keyword}) returning id`
    for (const o of fx.observations)
      await sql`insert into observation
        (entity_type, entity_id, metric, observed_on, source_id, value, currency, method, fetched_at)
        values (${o.entityType}, ${o.platformId ? (ids.get(o.platformId) as string) : (kw?.id as string)},
          ${o.metric}, ${o.observedOn}, ${o.sourceId}, ${o.value}, ${o.currency}, ${o.method}, now())`
    for (const r of fx.reviews)
      await sql`insert into marketplace_review
        (id, product_id, review_id, rating, title, body, reviewed_on, source_id)
        values (gen_random_uuid(), ${ids.get(r.platformId) as string}, ${r.reviewId}, ${r.rating},
          ${r.title}, ${r.body}, ${r.reviewedOn}, 'import')`
    await sql`insert into direction (id, workspace_id, name, marketplaces)
      values (gen_random_uuid(), ${ws.id}, '宠物用品', '{amazon-us}'::text[])`
    return fx
  } finally {
    await sql.end()
  }
}

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

test('品类洞察验收：新建研究 → 报告 → 转线索 → 候选可见 → 归档入档案库', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const suffix = Math.random().toString(36).slice(2, 10)
  await register(page, `category-accept-${suffix}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/').pop() as string
  const fx = await seed(slug, suffix)

  // 1. 新建研究并生成报告
  await page.goto(`${base}/category`)
  await waitForHydration(page)
  await page.getByRole('button', { name: '新建研究' }).click()
  const form = page.getByRole('form', { name: '品类研究' })
  await form.getByLabel('研究名称').fill('宠物慢食碗验收')
  await form.getByLabel('平台站点').selectOption('amazon-us')
  await form.getByLabel('类目 ID').fill(fx.categoryId)
  await form.getByLabel('关键词').fill(fx.keyword)
  await form.getByLabel('头部 N').fill('10')
  await form.getByRole('button', { name: '创建并生成报告' }).click()
  const report = page.getByTestId('category-report')
  await expect(report).toBeVisible({ timeout: 60_000 })

  // 2. 各模块要么有数据要么显示“无数据来源”（夹具无退货率，评论主题未配置 AI）
  await expect(page.getByTestId('stat-yoy')).toContainText('覆盖 9 个月')
  await expect(page.getByTestId('stat-return')).toContainText('无数据来源')
  await expect(page.getByTestId('module-matrix').locator('tbody tr')).toHaveCount(10)
  for (const id of ['module-trend', 'module-matrix', 'module-pain', 'module-suggestions']) {
    const module = page.getByTestId(id)
    await expect(module).toBeVisible()
    const text = (await module.innerText()).trim()
    expect(text.length, `${id} 不能为空白`).toBeGreaterThan(0)
  }
  await waitForHydration(page)
  await shot(page, '01-report')

  // 3. 竞品矩阵第一行转为线索（同款微改良）
  const firstRow = page.getByTestId('module-matrix').locator('tbody tr').first()
  // 行内文字含排名、品牌等，按夹具标题匹配出这一行对应的商品
  const rowText = await firstRow.innerText()
  const productTitle = fx.products.find((p) => rowText.includes(p.title.slice(0, 30)))?.title
  expect(productTitle, '矩阵第一行应对应夹具商品').toBeTruthy()
  await firstRow.getByRole('button', { name: '转为线索' }).click()
  const dialog = page.getByRole('dialog', { name: '转为跟卖线索' })
  await expect(dialog.getByText('同款微改良')).toBeVisible()
  await dialog.getByLabel('改良点').fill('底部加防滑硅胶圈，改食品级陶瓷')
  await dialog.getByRole('button', { name: '确认转为线索' }).click()
  await expect(firstRow.getByText('已转线索')).toBeVisible()
  await shot(page, '02-converted')

  // 4. 跟卖候选列表可见该线索，进入详情“核算”标签确认线索默认跟卖方式
  await page.goto(`${base}/follow?platform=amazon`)
  await waitForHydration(page)
  const candidate = page.getByRole('link', { name: (productTitle as string).slice(0, 30) }).first()
  await expect(candidate).toBeVisible()
  await shot(page, '03-follow-candidates')
  await candidate.click()
  await waitForHydration(page)
  await page.getByRole('tab', { name: /核算/ }).click()
  await expect(page.getByTestId('costing-tab').getByText('线索默认：同款微改良')).toBeVisible()
  await shot(page, '04-lead-costing-tab')

  // 5. 归档后在档案库“品类研究报告”可见
  await page.goto(`${base}/category`)
  await waitForHydration(page)
  await page.getByTestId('study-card').filter({ hasText: '宠物慢食碗验收' }).click()
  await expect(report).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '归档到档案库' }).click()
  await expect(page.getByText('已归档').first()).toBeVisible()
  await page.goto(`${base}/archive`)
  await waitForHydration(page)
  const archived = page.getByTestId('archived-study-row').filter({ hasText: '宠物慢食碗验收' })
  await expect(archived).toBeVisible()
  await shot(page, '05-archive')
  await archived.getByRole('link', { name: '查看报告' }).click()
  await expect(report).toBeVisible({ timeout: 30_000 })
})
