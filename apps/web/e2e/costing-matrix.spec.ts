import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-costing-decisions 2.3 / 3.1：商品簇详情“核算”标签——在页面上录入供应商与阶梯报价，矩阵显示不可用原因并高亮最优，
// 选定组合后看到成本瀑布、线索进入工作台待决定队列。方向、商品簇、价格观测、汇率、物流方案与成本参数直接写入隔离库，
// 不使用示例数据；截图留给协调者对照设计稿（docs/receipts/m3-costing-<日期>/）。

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const receipts = new URL(
  `../../../docs/receipts/m3-costing-${new Date().toLocaleDateString('sv-SE')}/`,
  import.meta.url,
).pathname

type Sql = ReturnType<typeof fixtureDb>
type Row = Record<string, unknown>

const TEXT_ARRAYS = new Set(['keywords'])

async function insert(sql: Sql, table: string, row: Row) {
  const values = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      // jsonb 列（含阶梯数组）转 JSON；text[] 列（keywords）按数组传
      v !== null && typeof v === 'object' && !(v instanceof Date) && !TEXT_ARRAYS.has(k)
        ? sql.json(v as never)
        : v,
    ]),
  )
  await sql`insert into ${sql(table)} ${sql(values as never)}`
}

/** 与 packages/marketdata 的 derivedEntityId 相同：币种等无表实体按自然键派生 UUID */
function derivedEntityId(ref: string) {
  const h = createHash('sha256').update(ref).digest('hex').slice(0, 32).split('')
  h[12] = '8'
  h[16] = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16)
  const x = h.join('')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

const formula = (firstPriceMinor: number) => ({
  kind: 'first-additional',
  currency: 'CNY',
  firstWeightG: 500,
  firstPriceMinor,
  stepWeightG: 500,
  stepPriceMinor: 1200,
  volumetricDivisor: 6000,
})

async function seed(slug: string, key: string) {
  const sql = fixtureDb()
  try {
    const [ws] = await sql`select id from organization where slug=${slug}`
    if (!ws) throw new Error('workspace missing')
    const workspaceId = ws.id as string
    // 节点 45 天后起卖：直发来得及，海外仓头程 40 天来不及
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
    // 汇率 USD/CNY 主值（手填优先于欧洲央行）
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
    const leadId = newId()
    await insert(sql, 'lead', {
      id: leadId,
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

    const profiles = [
      {
        name: '云途专线（直发）',
        type: 'ebay-direct',
        transit: 12,
        last: formula(2600),
        head: null,
        banned: ['battery'],
      },
      {
        name: '燕文经济（直发）',
        type: 'ebay-direct',
        transit: 18,
        last: formula(2100),
        head: null,
        banned: [],
      },
      {
        name: '美西海外仓',
        type: 'ebay-overseas',
        transit: 40,
        last: formula(1500),
        head: { kind: 'volume', currency: 'CNY', pricePerCbmMinor: 110_000, minCbm: 0.1 },
        banned: [],
      },
    ]
    for (const p of profiles)
      await sql`insert into logistics_profile (id, workspace_id, name, platform, type, transit_days, head_freight, last_mile, banned_attributes)
        values (${newId()}, ${workspaceId}, ${p.name}, 'ebay', ${p.type}, ${p.transit},
          ${p.head ? sql.json(p.head) : null}, ${sql.json(p.last)}, ${sql.array(p.banned)}::text[])`
    await insert(sql, 'cost_param', {
      id: newId(),
      workspace_id: workspaceId,
      platform: 'ebay',
      commission_rate: 0.136,
      fixed_fee_minor: 30,
      ad_rate: 0.06,
      return_rate: 0.03,
      storage_monthly_minor: 25,
      storage_months: 2,
    })

    // 另两家供应商：MOQ 高于计划数量、缺重量（页面上再录入一家完整报价）
    const bulk = newId()
    const sample = newId()
    for (const [id, name] of [
      [bulk, '台州塑料制品厂'],
      [sample, '深圳样品店'],
    ] as const)
      await insert(sql, 'supplier', { id, workspace_id: workspaceId, name, platform: '1688' })
    await insert(sql, 'supplier_quote', {
      id: newId(),
      workspace_id: workspaceId,
      supplier_id: bulk,
      cluster_id: clusterId,
      tiers: [
        { minQty: 1000, unitPriceMinor: 780 },
        { minQty: 3000, unitPriceMinor: 690 },
      ],
      currency: 'CNY',
      moq: 1000,
      weight_g: 420,
      dimensions: { lengthCm: 25, widthCm: 12, heightCm: 6 },
      confidence: 'confirmed',
      quoted_on: day(-3),
      procurement_days: 15,
    })
    await insert(sql, 'supplier_quote', {
      id: newId(),
      workspace_id: workspaceId,
      supplier_id: sample,
      cluster_id: clusterId,
      tiers: [{ minQty: 50, unitPriceMinor: 1450 }],
      currency: 'CNY',
      confidence: 'public',
      quoted_on: day(-6),
    })
    return { clusterId, leadId }
  } finally {
    await sql.end()
  }
}

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

test('核算标签：报价录入、矩阵最优与选定组合进入待决定', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `costing-matrix-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/')[2] as string
  const { clusterId } = await seed(slug, key)

  await page.goto(`${base}/follow/${clusterId}`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('tab', { name: /核算/ }).click()
  await expect(page).toHaveURL(/tab=costing/)
  const tab = page.getByTestId('costing-tab')
  await expect(tab.getByTestId('quote-row')).toHaveCount(2)
  await expect(tab.getByText('竞品中位价 USD 21.49 · 3 个成员')).toBeVisible()

  // 页面上录入一家完整报价（新建供应商、两档阶梯）
  await tab.getByRole('button', { name: '新增报价' }).click()
  const form = page.getByRole('form', { name: '报价' })
  await form.getByLabel('供应商', { exact: true }).selectOption({ label: '＋ 新建供应商…' })
  await form.getByLabel('供应商名称').fill('义乌佳美日用品厂')
  await form.getByLabel('供应商链接').fill('https://detail.1688.com/offer/6612345.html')
  await form.getByLabel('第 1 档数量').fill('200')
  await form.getByLabel('第 1 档单价').fill('9.80')
  await form.getByRole('button', { name: '＋ 添加一档' }).click()
  await form.getByLabel('第 2 档数量').fill('1000')
  await form.getByLabel('第 2 档单价').fill('8.60')
  await form.getByLabel('MOQ').fill('200')
  await form.getByLabel('单件重量（g）').fill('380')
  await form.getByLabel('长（cm）').fill('24')
  await form.getByLabel('宽（cm）').fill('12')
  await form.getByLabel('高（cm）').fill('6')
  await form.getByLabel('可信度').selectOption('confirmed')
  await form.getByLabel('采购天数').fill('10')
  await form.getByRole('button', { name: '保存报价' }).click()
  await expect(tab.getByTestId('quote-row')).toHaveCount(3)
  // 录入报价后线索进入核算
  await expect(page.locator('[aria-current="step"]')).toHaveText(/核算中/)

  await tab.getByLabel('计划数量（件）').fill('300')
  await tab.getByRole('button', { name: '重新计算' }).click()
  const matrix = tab.getByTestId('costing-matrix')
  await expect(matrix.getByTestId('matrix-cell')).toHaveCount(9)
  await expect(matrix.getByText('低于 MOQ').first()).toBeVisible()
  await expect(matrix.getByText('缺少：重量').first()).toBeVisible()
  await expect(matrix.getByText('来不及').first()).toBeVisible()
  const best = matrix.locator('[data-testid="matrix-cell"][data-best]')
  await expect(best).toHaveCount(1)
  await expect(best.getByText('最优')).toBeVisible()
  await shot(page, '01-costing-tab')
  await matrix.screenshot({ path: `${receipts}02-costing-matrix.png` })

  // 两种跟卖方式对比：微改良缺参数时显示缺少
  await tab.getByRole('button', { name: '两种对比' }).click()
  await expect(matrix.getByTestId('matrix-cell')).toHaveCount(18)
  await expect(matrix.getByText(/缺少：微改良参数/).first()).toBeVisible()
  await tab.getByRole('button', { name: '同款同货源' }).click()
  await expect(matrix.getByTestId('matrix-cell')).toHaveCount(9)

  // 选定最优组合 → 成本瀑布、线索进入待决定
  await best.click()
  const panel = tab.getByTestId('scenario-panel')
  await expect(panel.getByTestId('cost-waterfall').locator('canvas')).toBeVisible()
  await panel.getByRole('button', { name: '选定此组合，进入待决定' }).click()
  await expect(panel.getByText('已选定').first()).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toHaveText(/待决定/)
  await expect(matrix.getByText('已选定')).toHaveCount(1)
  await page.waitForTimeout(500)
  await panel.screenshot({ path: `${receipts}03-cost-waterfall.png` })
  await shot(page, '04-costing-selected')

  await page.goto(base)
  await page.waitForLoadState('networkidle')
  await expect(
    page.getByText('Magnetic Spice Rack for Refrigerator', { exact: false }).first(),
  ).toBeVisible()
})
