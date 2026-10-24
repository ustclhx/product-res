import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { fixtureDb, register, simulateClientIp, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-follow-selection 4.1 / 4.2：候选列表空状态、Amazon / eBay 切换（eBay 无 BSR 列）、商品簇详情
// （雷达缺失维度、来源悬浮、来源对比、人工刷新估算、拆分）。数据直接写入隔离库（流水线 3.1 尚未合并），
// 不使用示例数据；同时为协调者对照设计稿留下截图（docs/receipts/m2-candidates-<日期>/）。

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const today = day(0)
// 回执目录按本地日期命名（团队在新加坡时区）
const receipts = new URL(
  `../../../docs/receipts/m2-candidates-${new Date().toLocaleDateString('sv-SE')}/`,
  import.meta.url,
).pathname

type Sql = ReturnType<typeof fixtureDb>
type Row = Record<string, unknown>

async function insert(sql: Sql, table: string, rows: Row | Row[]) {
  const list = Array.isArray(rows) ? rows : [rows]
  for (const row of list) {
    const values = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
          ? sql.json(v as never)
          : v,
      ]),
    )
    await sql`insert into ${sql(table)} ${sql(values as never)}`
  }
}

const CONFIDENCE = (level: 'high' | 'low') => ({
  items: [
    {
      id: 'coverage',
      value: level === 'high' ? 0.82 : 0.35,
      note: '快照 28 天，3 个成员，3 家店铺',
    },
    { id: 'freshness', value: 1, note: '最近获取距今 6 小时' },
    {
      id: 'signal-consistency',
      value: level === 'high' ? 0.67 : 0.33,
      note: level === 'high' ? '2/3 个独立信号为正' : '1/3 个独立信号为正',
    },
    { id: 'source-consistency', value: level === 'high' ? 0.8 : 0.5, note: '1 组多来源对照' },
    { id: 'merge', value: 0.88, note: '成员平均归并置信度 0.88' },
    { id: 'season-stability', value: null, note: '历年数据不足' },
    {
      id: 'time-slack',
      value: level === 'high' ? 0.43 : 0.2,
      note: '余量 25 天 / 提前期 58 天（默认提前期）',
    },
    { id: 'competition-stability', value: 0.7, note: '价格波动率 9%' },
  ],
  unverifiedMetrics: level === 'high' ? ['bsr', 'price'] : ['price', 'sales_estimate_monthly'],
})

interface ClusterSpec {
  marketplace: 'amazon-us' | 'ebay-us'
  titles: string[]
  score: number | null
  confidence: number
  vetoed?: boolean
  gates?: Row
  decisionIn?: number | null
  signals: Record<string, number | null>
  risks?: Array<{ kind: string; level: string; veto?: boolean; basis: string; link?: string }>
  level?: 'high' | 'low'
}

/** 写入一个方向下的簇、成员、线索、维度信号、风险与观测值；返回各簇 ID */
async function seed(slug: string, key: string) {
  const sql = fixtureDb()
  try {
    const [ws] = await sql`select id from organization where slug=${slug}`
    if (!ws) throw new Error('workspace missing')
    const workspaceId = ws.id as string
    const phrase = `back to school organizer ${key}`
    const nodeId = newId()
    await insert(sql, 'seasonal_node', {
      id: nodeId,
      workspace_id: workspaceId,
      name: '返校季',
      start_month: 7,
      start_day: 15,
      sales_days: 45,
      keywords: [phrase],
    })
    const directionId = newId()
    await sql`insert into direction (id, workspace_id, name, marketplaces, keywords, node_ids)
      values (${directionId}, ${workspaceId}, '厨房与宠物用品', ${sql.array(['amazon-us', 'ebay-us'])}::text[],
        ${sql.array(['dog bowl', 'baking mat'])}::text[], ${sql.array([nodeId])}::uuid[])`

    // 季节：两年的月度搜索趋势（7–8 月高峰）
    const keywordId = newId()
    await insert(sql, 'marketplace_keyword', { id: keywordId, marketplace: 'amazon-us', phrase })
    const trend = [32, 30, 35, 38, 45, 62, 88, 95, 60, 42, 40, 36]
    for (const year of [2025, 2026]) {
      for (let m = 1; m <= 12; m += 1) {
        if (year === 2026 && m > 10) continue
        await insert(sql, 'observation', {
          entity_type: 'keyword',
          entity_id: keywordId,
          metric: 'search_trend_index',
          observed_on: `${year}-${String(m).padStart(2, '0')}-01`,
          source_id: 'dataforseo',
          value: Math.round((trend[m - 1] ?? 0) * (year === 2026 ? 1.12 : 1)),
          method: 'official',
          tier: 1,
          fetched_at: new Date(),
        })
      }
    }

    const ref = (metric: string, value: number, sourceId: string, method: string) => ({
      metric,
      value,
      observedOn: today,
      sourceId,
      method,
      fetchedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    })
    const specs: ClusterSpec[] = [
      {
        marketplace: 'amazon-us',
        titles: [
          'Slow Feeder Dog Bowl, Anti-Choking Puzzle Bowl for Medium Dogs',
          'Slow Feeder Dog Bowl Non-Slip Maze Bowl',
          'Dog Slow Feeder Bowl Bloat Stop 2 Cups',
        ],
        score: 78,
        confidence: 0.74,
        decisionIn: 25,
        level: 'high',
        signals: {
          'market-demand': 85,
          'growth-season': 74,
          'peer-spread': 66,
          profit: null,
          competition: 28,
          'supply-timing': 35,
          compliance: 90,
        },
        risks: [
          { kind: 'brand', level: 'low', basis: '品牌字段为 PetPal，品牌库未登记' },
          {
            kind: 'design-patent',
            level: 'info',
            basis: '迷宫纹样可能有外观专利，跟卖前人工检索',
            link: 'https://patents.google.com/?q=slow%20feeder%20dog%20bowl',
          },
        ],
      },
      {
        marketplace: 'amazon-us',
        titles: ['Silicone Baking Mat Set of 3, Non-Stick Reusable Sheets'],
        score: 81,
        confidence: 0.31,
        decisionIn: 9,
        level: 'low',
        signals: {
          'market-demand': 88,
          'growth-season': 79,
          'peer-spread': null,
          profit: null,
          competition: 30,
          'supply-timing': 45,
          compliance: 80,
        },
        risks: [{ kind: 'certification', level: 'medium', basis: '接触食品，需 FDA 食品级证明' }],
      },
      {
        marketplace: 'amazon-us',
        titles: ['USB-C Hub 7-in-1 Adapter with 4K HDMI'],
        score: 82,
        confidence: 0.66,
        vetoed: true,
        gates: {
          passed: false,
          failures: [{ gate: 'compliance', reason: '合规与侵权低于否决阈值' }],
        },
        decisionIn: 40,
        level: 'high',
        signals: {
          'market-demand': 90,
          'growth-season': 70,
          'peer-spread': 80,
          competition: 35,
          'supply-timing': 30,
          compliance: 0,
        },
        risks: [
          { kind: 'vero', level: 'high', veto: true, basis: '品牌 Anker 在 VeRO 名单中' },
          { kind: 'brand-registry', level: 'high', basis: '该 ASIN 已品牌备案' },
        ],
      },
      {
        marketplace: 'amazon-us',
        titles: ['Bamboo Drawer Organizer Expandable'],
        score: null,
        confidence: 0.22,
        decisionIn: null,
        level: 'low',
        signals: { 'market-demand': 52, compliance: 100, competition: 60 },
      },
      {
        marketplace: 'ebay-us',
        titles: [
          'LED Desk Lamp with USB Charging Port, Dimmable',
          'LED Desk Lamp USB Port Eye-Care',
        ],
        score: 76,
        confidence: 0.62,
        decisionIn: 30,
        level: 'high',
        signals: {
          'market-demand': 72,
          'growth-season': 68,
          'peer-spread': 75,
          competition: 40,
          'supply-timing': 30,
          compliance: 95,
        },
      },
      {
        marketplace: 'ebay-us',
        titles: ['Magnetic Spice Rack for Refrigerator 4 Pack'],
        score: 64,
        confidence: 0.48,
        decisionIn: 12,
        level: 'low',
        signals: {
          'market-demand': null,
          'growth-season': 66,
          'peer-spread': 58,
          competition: 45,
          'supply-timing': 40,
          compliance: 90,
        },
      },
    ]

    const ids: string[] = []
    for (const [index, spec] of specs.entries()) {
      const productIds: string[] = []
      for (const [i, title] of spec.titles.entries()) {
        const id = newId()
        productIds.push(id)
        await insert(sql, 'marketplace_product', {
          id,
          marketplace: spec.marketplace,
          platform_id: `${spec.marketplace === 'amazon-us' ? 'B0' : '3'}${key.replace(/\W/g, '').slice(-6).toUpperCase()}${index}${i}`,
          title,
          seller_id: ['petpal_store', 'homegoods_us', 'dealzone'][i] ?? 'seller',
          category_id: spec.marketplace === 'amazon-us' ? '2975312011' : '20625',
        })
      }
      const clusterId = newId()
      ids.push(clusterId)
      await insert(sql, 'cluster', {
        id: clusterId,
        workspace_id: workspaceId,
        direction_id: directionId,
        marketplace: spec.marketplace,
        representative_product_id: productIds[0],
        name: spec.titles[0],
      })
      for (const [i, productId] of productIds.entries())
        await insert(sql, 'cluster_member', {
          id: newId(),
          workspace_id: workspaceId,
          cluster_id: clusterId,
          product_id: productId,
          method: i === 0 ? 'gtin' : 'title',
          confidence: i === 0 ? 0.95 : 0.72 + i * 0.03,
        })
      await insert(sql, 'lead', {
        id: newId(),
        workspace_id: workspaceId,
        cluster_id: clusterId,
        direction_id: directionId,
        lead_on: today,
        score: spec.score,
        confidence: spec.confidence,
        confidence_detail: CONFIDENCE(spec.level ?? 'low'),
        gates: spec.gates ?? { passed: true, failures: [] },
        vetoed: spec.vetoed ?? false,
        latest_decision_on: spec.decisionIn == null ? null : day(spec.decisionIn),
        setting_version: 1,
      })
      const amazon = spec.marketplace === 'amazon-us'
      for (const [dimension, score] of Object.entries(spec.signals)) {
        const inputs =
          dimension === 'market-demand'
            ? amazon
              ? [
                  ref('sales_estimate_monthly', 3240, 'jungle-scout', 'estimate'),
                  ref('sales_estimate_monthly', 2980, 'keepa', 'estimate'),
                  ref('bsr', 12, 'keepa', 'estimate'),
                ]
              : score === null
                ? []
                : [ref('sold_quantity_total', 1840, 'ebay-browse', 'official')]
            : dimension === 'growth-season'
              ? [ref('search_trend_index', 88, 'dataforseo', 'official')]
              : dimension === 'competition'
                ? [
                    ref(
                      'price',
                      18.99,
                      amazon ? 'keepa' : 'ebay-browse',
                      amazon ? 'estimate' : 'official',
                    ),
                  ]
                : dimension === 'compliance'
                  ? [ref('risk_penalty', 10, 'risk-rules', 'derived')]
                  : []
        const reason =
          score === null
            ? dimension === 'profit'
              ? '无数据：没有落地成本输入（M3 核算后计算）'
              : dimension === 'market-demand'
                ? '无数据：没有已售数量观测'
                : '无数据：没有对标店铺的首次发现记录'
            : {
                'market-demand': amazon
                  ? '月销量估算 3,240（2 个来源），BSR #12'
                  : '7 天已售增量 126，加速 1.3×',
                'growth-season': '季节指数 1.62，近 90 天增长 18%',
                'peer-spread': '14 天内 4 家对标店铺上新',
                profit: '',
                competition: '卖家数 30 天 +2，最低价跌幅 3%',
                'supply-timing': '距最晚决定日余量 25 天（默认提前期）',
                compliance: score === 0 ? '命中 VeRO 名单，一票否决' : '100 − 风险扣分 10',
              }[dimension]
        await insert(sql, 'cluster_signal', {
          workspace_id: workspaceId,
          cluster_id: clusterId,
          observed_on: today,
          dimension,
          score,
          inputs: { reason, inputs },
        })
      }
      for (const risk of spec.risks ?? [])
        await insert(sql, 'risk_finding', {
          id: newId(),
          workspace_id: workspaceId,
          cluster_id: clusterId,
          kind: risk.kind,
          ref: risk.basis.slice(0, 12),
          level: risk.level,
          veto: risk.veto ?? false,
          evidence: { basis: risk.basis, ...(risk.link ? { link: risk.link } : {}) },
        })

      // 观测值：近 90 天价格（每 3 天）、销量与排名
      for (const [i, productId] of productIds.entries()) {
        const base = amazon ? 18.99 + i * 1.5 + index : 24.5 + i * 2 + index
        for (let d = 87; d >= 0; d -= 3) {
          const wave = Math.sin((d + i * 7) / 9) * 0.8 - (87 - d) * 0.006
          await insert(sql, 'observation', {
            entity_type: 'product',
            entity_id: productId,
            metric: 'price',
            observed_on: day(-d),
            source_id: amazon ? 'keepa' : 'ebay-browse',
            value: Math.round((base + wave) * 100) / 100,
            currency: 'USD',
            method: amazon ? 'estimate' : 'official',
            tier: amazon ? 3 : 1,
            fetched_at: new Date(Date.now() - d * 86_400_000),
          })
          if (amazon) {
            if (i === 0)
              await insert(sql, 'observation', {
                entity_type: 'product',
                entity_id: productId,
                metric: 'bsr',
                observed_on: day(-d),
                source_id: 'keepa',
                value: Math.round(12 + Math.abs(Math.sin(d / 5)) * 18 + d / 3),
                method: 'estimate',
                tier: 3,
                fetched_at: new Date(Date.now() - d * 86_400_000),
              })
            if (d % 15 === 0)
              await insert(sql, 'observation', {
                entity_type: 'product',
                entity_id: productId,
                metric: 'sales_estimate_monthly',
                observed_on: day(-d),
                source_id: 'jungle-scout',
                value: Math.round((3240 - d * 9) / (i + 1)),
                method: 'estimate',
                tier: 3,
                fetched_at: new Date(Date.now() - d * 86_400_000),
              })
          } else {
            await insert(sql, 'observation', {
              entity_type: 'product',
              entity_id: productId,
              metric: 'sold_quantity_total',
              observed_on: day(-d),
              source_id: 'ebay-browse',
              value: 1840 - Math.round(d * (14 + i * 4) + Math.sin(d) * 6),
              method: 'official',
              tier: 1,
              fetched_at: new Date(Date.now() - d * 86_400_000),
            })
          }
        }
      }
      // 代表商品的月销量今天有两个来源（离散度）
      if (amazon)
        await insert(sql, 'observation', {
          entity_type: 'product',
          entity_id: productIds[0],
          metric: 'sales_estimate_monthly',
          observed_on: today,
          source_id: 'keepa',
          value: 2980,
          method: 'estimate',
          tier: 3,
          fetched_at: new Date(Date.now() - 3 * 3_600_000),
        })
    }
    return { amazonTop: ids[0] as string, ids }
  } finally {
    await sql.end()
  }
}

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

test('跟卖候选列表与商品簇详情', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `cand-${key}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/')[2] as string

  // 空状态：说明先配置方向与数据源，不放示例数据
  await page.goto(`${base}/follow`)
  await waitForHydration(page)
  await expect(page.getByTestId('candidates-empty')).toBeVisible()
  await expect(page.getByText('还没有 Amazon 候选')).toBeVisible()
  await expect(page.getByText('配置覆盖 Amazon 站点的选品方向')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByTestId('follow-directions-link')).toBeVisible()
  await shot(page, '01-candidates-empty')

  const { amazonTop } = await seed(slug, key)

  // Amazon：有 BSR 列，按 综合分 × 置信度 排序
  await page.goto(`${base}/follow`)
  await waitForHydration(page)
  const table = page.getByRole('table', { name: 'Amazon 跟卖候选' })
  await expect(table).toBeVisible()
  await expect(table.getByRole('columnheader', { name: 'BSR' })).toBeVisible()
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toContainText('Slow Feeder Dog Bowl')
  await expect(rows.first()).toContainText('未验证')
  await expect(table.getByTestId('attention-tag')).toHaveText('值得关注但证据不足')
  await expect(rows.filter({ hasText: 'USB-C Hub' })).toContainText('不推荐')
  await expect(rows.filter({ hasText: 'USB-C Hub' })).toContainText('否决 · VeRO')
  await shot(page, '02-candidates-amazon')

  // eBay：只显示 eBay 线索，表头没有 BSR
  await page.getByRole('tab', { name: 'eBay' }).click()
  const ebay = page.getByRole('table', { name: 'eBay 跟卖候选' })
  await expect(ebay).toBeVisible()
  await expect(page).toHaveURL(/platform=ebay/)
  await expect(ebay.getByRole('columnheader', { name: 'BSR' })).toHaveCount(0)
  await expect(ebay.locator('tbody tr')).toHaveCount(2)
  await expect(ebay).not.toContainText('Slow Feeder')
  await shot(page, '03-candidates-ebay')

  // 详情
  await page.goto(`${base}/follow/${amazonTop}`)
  await waitForHydration(page)
  await expect(
    page.getByRole('heading', { name: /Slow Feeder Dog Bowl, Anti-Choking/ }),
  ).toBeVisible()
  await expect(page.getByTestId('overall-score')).toHaveText('78')
  await expect(page.getByTestId('dimension-score-profit')).toHaveText('无数据')
  await expect(page.getByTestId('dimension-score-market-demand')).toHaveText('85')
  await expect(page.getByTestId('radar-missing')).toContainText('利润空间')
  await expect(page.getByRole('img', { name: '7 维雷达' })).toBeVisible()
  await expect(page.getByTestId('risk-card').getByText('在 Google Patents 检索 ↗')).toBeVisible()
  await expect(page.getByTestId('members').getByTestId('member-row')).toHaveCount(3)
  // 等待图表绘制完成再截图
  await page.waitForTimeout(800)
  await shot(page, '04-cluster-detail')

  // 悬浮月销量：各来源值、主值来源、离散度与获取时间
  const sales = page.getByTestId('stat-sales').getByTestId('source-hover-sales_estimate_monthly')
  await sales.hover()
  const tooltip = sales.getByRole('tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('jungle-scout')
  await expect(tooltip).toContainText('主值')
  await expect(tooltip).toContainText('离散度 9%')
  await page.screenshot({
    path: `${receipts}05-sales-sources-hover.png`,
    clip: await page
      .getByTestId('stat-sales')
      .boundingBox()
      .then((b) => ({ x: (b?.x ?? 0) - 260, y: (b?.y ?? 0) - 10, width: 420, height: 230 })),
  })

  // 人工刷新：先显示预计花费（模拟数据源），不直接调用
  const firstMember = page.getByTestId('member-row').first()
  await firstMember.getByRole('button', { name: '人工刷新' }).click()
  await expect(page.getByTestId('refresh-panel')).toContainText('预计花费')
  await page.getByTestId('refresh-panel').scrollIntoViewIfNeeded()
  await page.getByTestId('members').screenshot({ path: `${receipts}06-members-refresh.png` })

  // 拆分最后一个成员
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId('member-row').last().getByRole('button', { name: '拆分' }).click()
  await expect(page.getByTestId('members').getByTestId('member-row')).toHaveCount(2)
  await expect(page.getByText('拆出 1 个成员为新簇')).toBeVisible()
})
