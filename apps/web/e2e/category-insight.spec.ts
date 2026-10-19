import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import type { SnapshotModules } from '../src/features/category/types.ts'
import { categoryFixture } from '../test/fixtures/category-insight-data.ts'
import { fixtureDb, register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-category-insight 3.2 / 3.4：报告页截图对照设计稿；夹具数据直接写入隔离库。
// 截图保存到 docs/receipts/m4-category-<日期>/，作为验收证据。
const now = new Date()
// 按本地日期命名目录（与执行验收的日期一致）
const day = now.toLocaleDateString('sv-SE')
const receipts = new URL(`../../../docs/receipts/m4-category-${day}/`, import.meta.url).pathname

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
    return { fx, workspaceId: ws.id as string }
  } finally {
    await sql.end()
  }
}

/**
 * 截图用：在最新快照上补一份 AI 主题与建议（夹具，代替真实模型输出），插入为更新的快照。
 * 只用于展示主题占比与建议卡片的版式；真实生成路径由集成测试覆盖。
 */
async function addAiFixtureSnapshot(workspaceId: string, suffix: string) {
  const sql = fixtureDb()
  try {
    const [snap] =
      await sql`select s.study_id, s.modules, s.data_as_of from category_study_snapshot s
      where s.workspace_id = ${workspaceId} order by generated_at desc limit 1`
    if (!snap) throw new Error('snapshot missing')
    const reviews = await sql`select r.id, r.review_id, r.rating, r.title, r.body, r.product_id
      from marketplace_review r where r.review_id like ${`R${suffix}-%`}`
    const byKey = new Map(reviews.map((r) => [r.review_id as string, r]))
    const rid = (i: number) => byKey.get(`R${suffix}-${i}`)?.id as string
    const modules = snap.modules as SnapshotModules
    const rows = modules.competitors.status === 'ok' ? modules.competitors.rows : []
    for (const r of reviews)
      modules.reviews[r.id] = {
        id: r.id,
        productId: r.product_id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        sourceId: 'import',
      }
    const ai = {
      modelKey: 'fixture-model',
      generatedAt: new Date().toISOString(),
      fingerprint: 'fixture',
      reusedFrom: null,
    }
    const theme = (label: string, idx: number[]) => ({
      label,
      reviewCount: idx.length,
      share: idx.length / 16,
      reviewIds: idx.slice(0, 3).map(rid),
    })
    modules.painPoints.themes = {
      status: 'ok',
      analyzed: 16,
      ai,
      themes: [
        theme('底部打滑', [0, 6, 12, 13]),
        theme('材质易裂', [1, 8, 15, 7]),
        theme('难清洗', [2, 5, 11]),
        theme('尺寸偏小', [3, 9]),
        theme('异味', [4, 14]),
        theme('色差', [10]),
      ],
    }
    modules.suggestions = {
      status: 'ok',
      dropped: 1,
      ai,
      items: [
        {
          title: '底部一体防滑硅胶圈',
          detail: '头部商品差评集中在地面打滑，底部加宽硅胶圈并做吸附纹理。',
          citations: [
            { kind: 'review', id: rid(0) },
            { kind: 'review', id: rid(6) },
            { kind: 'product', id: rows[0]?.id as string },
          ],
        },
        {
          title: '改用食品级陶瓷或加厚 PP',
          detail: '多条差评提到一周内开裂、廉价感，材质升级拉开与低价款的差距。',
          citations: [
            { kind: 'review', id: rid(1) },
            { kind: 'review', id: rid(8) },
            { kind: 'product', id: rows[1]?.id as string },
          ],
        },
        {
          title: '可拆迷宫 + 可洗碗机',
          detail: '迷宫纹路难清洗是第三大痛点，做成可拆插件并标注洗碗机安全。',
          citations: [
            { kind: 'review', id: rid(2) },
            { kind: 'review', id: rid(5) },
            { kind: 'product', id: rows[6]?.id as string },
          ],
        },
      ],
    }
    await sql`insert into category_study_snapshot (id, workspace_id, study_id, generated_at, data_as_of, modules)
      values (gen_random_uuid(), ${workspaceId}, ${snap.study_id}, now(), ${snap.data_as_of}, ${sql.json(modules as never)})`
  } finally {
    await sql.end()
  }
}

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  // 等图表绘制（ECharts 初始化与词云扩展按需加载）
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

test('品类洞察：新建研究生成报告、快照切换、来源查看、转线索', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const suffix = Math.random().toString(36).slice(2, 10)
  await register(page, `category-${suffix}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/').pop() as string
  const { fx, workspaceId } = await seed(slug, suffix)

  await page.goto(`${base}/category`)
  await waitForHydration(page)
  await expect(page.getByText('还没有品类研究')).toBeVisible()
  await page.getByRole('button', { name: '新建研究' }).click()
  const form = page.getByRole('form', { name: '品类研究' })
  await form.getByLabel('研究名称').fill('宠物慢食碗')
  await form.getByLabel('平台站点').selectOption('amazon-us')
  await form.getByLabel('类目 ID').fill(fx.categoryId)
  await form.getByLabel('关键词').fill(fx.keyword)
  await form.getByLabel('头部 N').fill('10')
  await form.getByRole('button', { name: '创建并生成报告' }).click()

  const report = page.getByTestId('category-report')
  await expect(report).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('stat-yoy')).toContainText('覆盖 9 个月')
  await expect(page.getByTestId('stat-return')).toContainText('无数据来源')
  await expect(page.getByTestId('stat-cr')).toContainText('已交叉验证')
  await expect(page.getByTestId('module-matrix').locator('tbody tr')).toHaveCount(10)
  await waitForHydration(page)
  await shot(page, '01-report-generated')

  // AI 主题与建议的版式（夹具快照），同时验证快照切换
  await addAiFixtureSnapshot(workspaceId, suffix)
  await page.reload()
  await waitForHydration(page)
  await expect(page.getByTestId('module-suggestions')).toContainText('底部一体防滑硅胶圈')
  await page.getByTestId('module-suggestions').getByText('依据：').first().click()
  await shot(page, '02-report-ai-themes-suggestions')

  // 查看来源
  const firstRow = page.getByTestId('module-matrix').locator('tbody tr').first()
  // 第二个来源按钮是月销量估算：主值 jungle-scout，同日另有 sellersprite
  await firstRow.getByLabel('查看来源').nth(1).click()
  await expect(firstRow.getByText('同日其他来源')).toBeVisible()
  await page.getByTestId('module-matrix').screenshot({ path: `${receipts}03-matrix-source.png` })
  await firstRow.getByLabel('查看来源').nth(1).click()

  // 转为线索（同款微改良）
  await firstRow.getByRole('button', { name: '转为线索' }).click()
  const dialog = page.getByRole('dialog', { name: '转为跟卖线索' })
  await expect(dialog.getByText('同款微改良')).toBeVisible()
  await dialog.getByLabel('改良点').fill('底部加防滑硅胶圈，改食品级陶瓷')
  await shot(page, '04-convert-dialog')
  await dialog.getByRole('button', { name: '确认转为线索' }).click()
  await expect(firstRow.getByText('已转线索')).toBeVisible()

  // 历史快照仍可选择
  const select = page.getByLabel('快照')
  await expect(select.locator('option')).toHaveCount(2)
  const older = await select.locator('option').nth(1).getAttribute('value')
  await select.selectOption(older as string)
  await expect(page.getByText('正在查看历史快照')).toBeVisible()

  // 无数据的研究：各模块显示“无数据来源”
  await page.goto(`${base}/category`)
  await waitForHydration(page)
  await page.getByRole('button', { name: '新建研究' }).click()
  const empty = page.getByRole('form', { name: '品类研究' })
  await empty.getByLabel('研究名称').fill('尚无数据的品类')
  await empty.getByLabel('关键词').fill(`no data ${suffix}`)
  await empty.getByRole('button', { name: '创建并生成报告' }).click()
  await expect(report).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('module-trend')).toContainText('无数据来源')
  await expect(page.getByTestId('module-pain')).toContainText('无数据来源')
  await waitForHydration(page)
  await shot(page, '05-report-no-source')

  await page.goto(`${base}/category`)
  await waitForHydration(page)
  await expect(page.getByTestId('study-card')).toHaveCount(2)
  await shot(page, '06-study-list')
})
