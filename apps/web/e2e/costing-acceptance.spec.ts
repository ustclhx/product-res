import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-costing-decisions 5.1 验收：一条线索 发现 → 核算 → 待决定 → 跟卖 → 档案库。
// 线索（方向、节点、簇、成员、价格观测、汇率、线索行）由夹具写入隔离库；其余全部走页面：
// 录入供应商报价 → 设置物流方案与成本参数 → 矩阵选定组合 → 工作台待决定队列 → 跟卖决定 → 档案库快照。
// 截图保存到 docs/receipts/m3-acceptance-<日期>/。

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const receipts = new URL(
  `../../../docs/receipts/m3-acceptance-${new Date().toLocaleDateString('sv-SE')}/`,
  import.meta.url,
).pathname

type Sql = ReturnType<typeof fixtureDb>
type Row = Record<string, unknown>

async function insert(sql: Sql, table: string, row: Row) {
  const values = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object' && !(v instanceof Date) && k !== 'keywords'
        ? sql.json(v as never)
        : v,
    ]),
  )
  await sql`insert into ${sql(table)} ${sql(values as never)}`
}

/** 与 packages/marketdata 的 derivedEntityId 相同：币种按自然键派生 UUID */
function derivedEntityId(ref: string) {
  const h = createHash('sha256').update(ref).digest('hex').slice(0, 32).split('')
  h[12] = '8'
  h[16] = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)
  const x = h.join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

async function seed(slug: string, key: string) {
  const sql = fixtureDb()
  try {
    const [ws] = await sql`select id from organization where slug=${slug}`
    if (!ws) throw new Error('workspace missing')
    const workspaceId = ws.id as string
    // 节点 45 天后起卖：12 天直发 + 10 天采购来得及
    const start = new Date(Date.now() + 45 * 86_400_000)
    const nodeId = newId()
    await insert(sql, 'seasonal_node', {
      id: nodeId,
      workspace_id: workspaceId,
      name: '感恩节',
      start_month: start.getUTCMonth() + 1,
      start_day: start.getUTCDate(),
      sales_days: 20,
      keywords: [],
    })
    const directionId = newId()
    await sql`insert into direction (id, workspace_id, name, marketplaces, keywords, node_ids)
      values (${directionId}, ${workspaceId}, '厨房收纳', ${sql.array(['ebay-us'])}::text[],
        ${sql.array(['spice rack'])}::text[], ${sql.array([nodeId])}::uuid[])`

    const titles = [
      'Magnetic Spice Rack for Refrigerator, 4 Pack Fridge Organizer',
      'Magnetic Fridge Spice Shelf, Strong Magnet Kitchen Rack',
      'Refrigerator Magnetic Spice Rack Organizer 2 Tier',
    ]
    const prices = [19.99, 21.49, 24.99]
    const productIds: string[] = []
    for (const [i, title] of titles.entries()) {
      const id = newId()
      productIds.push(id)
      await insert(sql, 'marketplace_product', {
        id,
        marketplace: 'ebay-us',
        platform_id: `39${key.replace(/\W/g, '').slice(-8)}${i}`,
        title,
        seller_id: ['kitchenpro', 'homegoods_us', 'dealzone'][i],
        category_id: '20625',
      })
      await insert(sql, 'observation', {
        entity_type: 'product',
        entity_id: id,
        metric: 'price',
        observed_on: day(-1),
        source_id: 'ebay-browse',
        value: prices[i],
        currency: 'USD',
        method: 'official',
        fetched_at: new Date(),
      })
    }
    // 汇率 USD/CNY 主值
    await sql`insert into observation (entity_type, entity_id, metric, observed_on, source_id, value, method, fetched_at)
      values ('currency', ${derivedEntityId('currency:global:USD/CNY')}, 'fx_rate', ${day(-1)}, 'manual', 7.1, 'import', now())
      on conflict do nothing`

    const clusterId = newId()
    await insert(sql, 'cluster', {
      id: clusterId,
      workspace_id: workspaceId,
      direction_id: directionId,
      marketplace: 'ebay-us',
      representative_product_id: productIds[0],
      name: titles[0],
    })
    for (const [i, productId] of productIds.entries())
      await insert(sql, 'cluster_member', {
        id: newId(),
        workspace_id: workspaceId,
        cluster_id: clusterId,
        product_id: productId,
        method: i === 0 ? 'gtin' : 'title',
        confidence: 0.9 - i * 0.05,
      })
    await insert(sql, 'lead', {
      id: newId(),
      workspace_id: workspaceId,
      cluster_id: clusterId,
      direction_id: directionId,
      lead_on: day(0),
      score: 77,
      confidence: 0.68,
      gates: { passed: true, failures: [] },
      latest_decision_on: day(20),
      setting_version: 1,
      status: 'new',
    })
    return { clusterId, title: titles[0] as string }
  } finally {
    await sql.end()
  }
}

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

test('核算决定验收：线索 → 报价 → 设置 → 矩阵 → 待决定 → 跟卖 → 档案库', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `costing-accept-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/')[2] as string
  const { clusterId, title } = await seed(slug, key)
  const clusterName = title.slice(0, 30)

  // 1. 商品簇详情“核算”标签录入供应商报价（此时尚无物流方案，矩阵为空）
  await page.goto(`${base}/follow/${clusterId}`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('tab', { name: /核算/ }).click()
  await expect(page).toHaveURL(/tab=costing/)
  const tab = page.getByTestId('costing-tab')
  await expect(tab.getByText('竞品中位价 USD 21.49 · 3 个成员')).toBeVisible()
  await tab.getByRole('button', { name: '新增报价' }).click()
  const quote = page.getByRole('form', { name: '报价' })
  await quote.getByLabel('供应商', { exact: true }).selectOption({ label: '＋ 新建供应商…' })
  await quote.getByLabel('供应商名称').fill('义乌佳美日用品厂')
  await quote.getByLabel('供应商链接').fill('https://detail.1688.com/offer/6612345.html')
  await quote.getByLabel('第 1 档数量').fill('200')
  await quote.getByLabel('第 1 档单价').fill('9.80')
  await quote.getByRole('button', { name: '＋ 添加一档' }).click()
  await quote.getByLabel('第 2 档数量').fill('1000')
  await quote.getByLabel('第 2 档单价').fill('8.60')
  await quote.getByLabel('MOQ').fill('200')
  await quote.getByLabel('单件重量（g）').fill('380')
  await quote.getByLabel('长（cm）').fill('24')
  await quote.getByLabel('宽（cm）').fill('12')
  await quote.getByLabel('高（cm）').fill('6')
  await quote.getByLabel('可信度').selectOption('confirmed')
  await quote.getByLabel('采购天数').fill('10')
  await quote.getByRole('button', { name: '保存报价' }).click()
  await expect(tab.getByTestId('quote-row')).toHaveCount(1)
  await expect(page.locator('[aria-current="step"]')).toHaveText(/核算中/)
  await shot(page, '01-quote-entered')

  // 2. 设置页：物流方案与成本参数
  await page.goto(`${base}/config`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('tab', { name: '物流方案' }).click()
  await page.getByRole('button', { name: '新增方案' }).click()
  const profile = page.getByRole('form', { name: '物流方案' })
  await profile.getByLabel('方案名称').fill('云途专线')
  await profile.getByLabel('时效（天）').fill('12')
  await profile.getByLabel('币种').fill('CNY')
  await profile.getByLabel('首重价格').fill('26')
  await profile.getByLabel('续重价格').fill('12')
  await profile.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: '云途专线' })).toBeVisible()
  await shot(page, '02-logistics-profile')

  await page.getByRole('tab', { name: '成本参数' }).click()
  await page.getByRole('button', { name: '新增参数' }).click()
  const param = page.getByRole('form', { name: '成本参数' })
  // 表单默认平台为 Amazon，本线索在 eBay
  await param.getByLabel('平台', { exact: true }).selectOption({ label: 'eBay' })
  await param.getByLabel('佣金率（%）').fill('13.6')
  await param.getByLabel('固定费').fill('0.30')
  await param.getByLabel('广告率（%）').fill('6')
  await param.getByLabel('退货预留（%）').fill('3')
  await param.getByRole('button', { name: '保存' }).click()
  await expect(page.getByTestId('cost-param-row')).toHaveCount(1)
  await shot(page, '03-cost-params')

  // 3. 矩阵选定最优组合，线索进入待决定
  await page.goto(`${base}/follow/${clusterId}?tab=costing`)
  await page.waitForLoadState('networkidle')
  await tab.getByLabel('计划数量（件）').fill('300')
  await tab.getByRole('button', { name: '重新计算' }).click()
  const matrix = tab.getByTestId('costing-matrix')
  await expect(matrix.getByTestId('matrix-cell')).toHaveCount(1)
  const best = matrix.locator('[data-testid="matrix-cell"][data-best]')
  await expect(best).toHaveCount(1)
  await best.click()
  const panel = tab.getByTestId('scenario-panel')
  await expect(panel.getByTestId('cost-waterfall').locator('canvas')).toBeVisible()
  await panel.getByRole('button', { name: '选定此组合，进入待决定' }).click()
  await expect(panel.getByText('已选定').first()).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toHaveText(/待决定/)
  await shot(page, '04-scenario-selected')

  // 4. 工作台首页待决定队列出现该线索
  await page.goto(base)
  await page.waitForLoadState('networkidle')
  const row = page.getByTestId('queue-row').filter({ hasText: clusterName })
  await expect(row).toHaveCount(1)
  await expect(row.getByText(/毛利率/)).toBeVisible()
  await shot(page, '05-queue')

  // 5. 跟卖决定
  await row.getByRole('button', { name: '跟卖' }).click()
  const decision = page.getByRole('form', { name: '跟卖决定' })
  await expect(decision.getByLabel('首批数量')).toHaveValue('300')
  await decision.getByLabel('计划上架日').fill(day(40))
  await shot(page, '06-decision-form')
  await decision.getByRole('button', { name: '确认跟卖' }).click()
  await expect(page.getByText('没有待决定的线索')).toBeVisible()

  // 6. 选品档案库看到记录与决定时快照
  await page.goto(`${base}/archive`)
  await page.waitForLoadState('networkidle')
  const archived = page.getByTestId('archive-row').filter({ hasText: clusterName })
  await expect(archived).toHaveCount(1)
  await expect(archived.getByText('跟卖').first()).toBeVisible()
  await archived.getByRole('button', { name: '查看快照' }).click()
  const snapshot = page.getByTestId('decision-snapshot')
  await expect(snapshot).toBeVisible()
  await expect(snapshot.getByText('v1')).toBeVisible()
  await expect(snapshot.getByText('77', { exact: true })).toBeVisible()
  await expect(snapshot.getByText('同款同货源')).toBeVisible()
  await shot(page, '07-archive-snapshot')

  // 已决定后核算锁定：详情页不再提供“选定此组合”
  await page.goto(`${base}/follow/${clusterId}?tab=costing`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: '选定此组合，进入待决定' })).toHaveCount(0)
})
