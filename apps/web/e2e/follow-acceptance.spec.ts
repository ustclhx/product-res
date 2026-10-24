import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { createDb } from '@product-res/db'
import { runSelectionForWorkspace } from '@product-res/follow'
import { newId } from '@product-res/shared'
import { loadEnv } from 'vite'
import { fixtureDb, register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-follow-selection 5.1 验收：页面上配置方向与品牌库 → 直接写入隔离库的市场数据（不经真实连接器）
// → 运行每日流水线（只跑本测试空间）→ 候选列表出现线索 → 详情页说明推荐理由与来源。
// 回执与截图：docs/receipts/m2-acceptance-<日期>.md 与同名目录。

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const receipts = new URL(
  `../../../docs/receipts/m2-acceptance-${new Date().toLocaleDateString('sv-SE')}/`,
  import.meta.url,
).pathname
const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

/** 模拟连接器写入的市场数据：eBay 商品与观测值（来源 ebay-browse，同日价格另有 dataforseo） */
async function seedMarket(category: string, key: string) {
  const sql = fixtureDb()
  try {
    // 市场数据在同一 worktree 内跨轮次保留；种子卖家必须唯一，避免选入上轮商品。
    const products = [
      {
        id: `spice-a-${key}`,
        title: 'Bamboo Spice Rack Organizer 3 Tier for Kitchen Cabinet',
        seller: `kitchen_pro-${key}`,
        gtin: '0012345678905',
        listed: day(-3),
      },
      {
        id: `spice-b-${key}`,
        title: 'Bamboo Spice Rack Organizer 3 Tier Kitchen Cabinet Shelf',
        seller: 'home_shelf',
        gtin: '12345678905',
        listed: day(-40),
      },
      {
        id: `knife-${key}`,
        title: 'Acmeknife Kitchen Knife Sharpener 3 Stage',
        seller: 'blade_deals',
        brand: 'Acmeknife',
        listed: day(-40),
      },
    ]
    const ids: Record<string, string> = {}
    for (const p of products) {
      const [row] = await sql`insert into marketplace_product
        (id, marketplace, platform_id, title, seller_id, gtin, brand, category_id, listed_at, first_seen_at)
        values (${newId()}, 'ebay-us', ${p.id}, ${p.title}, ${p.seller}, ${p.gtin ?? null}, ${p.brand ?? null},
          ${category}, ${p.listed}::date, now() - interval '20 days')
        returning id`
      ids[p.id] = row?.id as string
    }
    const obs = async (
      entityId: string,
      metric: string,
      offset: number,
      value: number,
      sourceId = 'ebay-browse',
    ) => {
      await sql`insert into observation
        (entity_type, entity_id, metric, observed_on, source_id, value, method, tier, fetched_at)
        values ('product', ${entityId}, ${metric}, ${day(offset)}::date, ${sourceId}, ${value},
          'official', 1, now() - (${-offset} || ' days')::interval - interval '2 hours')`
    }
    const a = ids[`spice-a-${key}`] as string
    const b = ids[`spice-b-${key}`] as string
    const k = ids[`knife-${key}`] as string
    for (const [offset, sold] of [
      [-30, 400],
      [-7, 520],
      [0, 640],
    ] as const) {
      await obs(a, 'sold_quantity_total', offset, sold)
      await obs(b, 'sold_quantity_total', offset, sold / 2)
      await obs(a, 'price', offset, 24.99 - offset / 30)
      await obs(b, 'price', offset, 22.5)
      await obs(a, 'review_count', offset, 120)
      await obs(k, 'sold_quantity_total', offset, sold + 300)
      await obs(k, 'price', offset, 19.99)
    }
    // 同一天另一个来源的价格：详情页“来源对比”展示两个来源
    await obs(a, 'price', 0, 25.49, 'dataforseo')
    return Object.values(ids)
  } finally {
    await sql.end()
  }
}

test('M2 验收：配置方向 → 流水线 → 候选列表 → 详情说明推荐理由与来源', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const category = `e2e-${key}`
  await register(page, `m2-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/')[2] as string

  // 1. 配置：品牌库登记 VeRO 品牌，新建方向（eBay US、类目、返校季节点）并添加种子店铺
  await page.goto(`${base}/config`)
  await waitForHydration(page)
  await page.getByRole('tab', { name: '品牌库' }).click()
  await page.getByRole('button', { name: '新增条目' }).click()
  const brand = page.getByRole('form', { name: '品牌库条目' })
  await brand.getByLabel('品牌名').fill('Acmeknife')
  await brand.getByLabel('类型').selectOption('vero')
  await brand.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('cell', { name: 'Acmeknife' })).toBeVisible()

  await page.goto(`${base}/follow/directions`)
  await waitForHydration(page)
  await page.getByRole('button', { name: '新建方向' }).click()
  const form = page.getByRole('form', { name: '选品方向' })
  await form.getByLabel('方向名称').fill('厨房收纳（验收）')
  await form.getByLabel('eBay US').check()
  await form.getByLabel('类目 ID').fill(category)
  await form.getByLabel('返校季').check()
  await form.getByRole('button', { name: '保存' }).click()
  const card = page.getByTestId('direction-card')
  await expect(card).toHaveCount(1)
  const seedForm = card.getByRole('form', { name: '为厨房收纳（验收）添加种子店铺' })
  await seedForm.getByLabel('卖家 ID').fill(`kitchen_pro-${key}`)
  await seedForm.getByRole('button', { name: '添加种子店铺' }).click()
  await expect(card.getByText(`kitchen_pro-${key}`)).toBeVisible()
  await shot(page, '01-direction-configured')

  // 2. 市场数据（模拟连接器写入）与流水线：只运行本空间，不处理库里其他空间的方向
  const sql = fixtureDb()
  const [ws] = await sql`select id from organization where slug=${slug}`
  await sql.end()
  const workspaceId = ws?.id as string
  await seedMarket(category, key)
  const db = createDb(env.DATABASE_URL as string)
  try {
    const run = await runSelectionForWorkspace(db, workspaceId, { now: new Date() })
    expect(run.failures).toEqual([])
    expect(run.directions[0]).toMatchObject({ clusters: 2, createdClusters: 2, leads: 2 })
  } finally {
    await db.$client.end()
  }

  // 3. 候选列表：出现两条 eBay 线索；VeRO 品牌的簇被否决
  await page.goto(`${base}/follow?platform=ebay`)
  await waitForHydration(page)
  const table = page.getByRole('table', { name: 'eBay 跟卖候选' })
  await expect(table).toBeVisible()
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  const spice = rows.filter({ hasText: 'Bamboo Spice Rack' })
  await expect(spice).toHaveCount(1)
  await expect(spice).toContainText('未验证')
  await expect(rows.filter({ hasText: 'Acmeknife' })).toContainText('不推荐')
  await expect(rows.filter({ hasText: 'Acmeknife' })).toContainText('VeRO')
  await shot(page, '02-candidates')

  // 4. 详情：维度理由、来源标注、来源对比与风险说明
  await spice.getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`${base}/follow/[0-9a-f-]{36}`))
  await waitForHydration(page)
  await expect(page.getByRole('heading', { name: /Bamboo Spice Rack Organizer/ })).toBeVisible()
  await expect(page.getByTestId('overall-score')).not.toHaveText('—')
  const dims = page.getByTestId('dimension-list')
  await expect(page.getByTestId('dimension-score-market-demand')).not.toHaveText('无数据')
  await expect(dims).toContainText('7 天销量增量约')
  await expect(dims).toContainText('对标店铺上架同簇商品')
  await expect(dims).toContainText('eBay Browse API')
  // 未核算：利润空间为空而不是 0
  await expect(page.getByTestId('dimension-score-profit')).toHaveText('无数据')
  await expect(page.getByTestId('radar-missing')).toContainText('利润空间')
  await expect(page.getByTestId('source-compare')).toContainText('DataForSEO')
  await expect(page.getByTestId('confidence-card')).toContainText('成本确定性')
  await expect(page.getByTestId('members').getByTestId('member-row')).toHaveCount(2)
  await page.waitForTimeout(800)
  await shot(page, '03-cluster-detail')

  // 被否决的簇：风险卡片说明 VeRO 命中
  await page.goto(`${base}/follow?platform=ebay`)
  await waitForHydration(page)
  await page
    .getByRole('table', { name: 'eBay 跟卖候选' })
    .locator('tbody tr')
    .filter({ hasText: 'Acmeknife' })
    .getByRole('link')
    .first()
    .click()
  await waitForHydration(page)
  await expect(page.getByTestId('risk-card')).toContainText('VeRO')
  await expect(page.getByTestId('dimension-list')).toContainText('一票否决')
  await page.waitForTimeout(800)
  await shot(page, '04-vetoed-detail')
})
