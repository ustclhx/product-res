import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// add-shadow-validation 4.1：算法验证页冷启动空状态与有样本状态的截图对照。
// 样本由测试直接写入隔离库（推荐、T+30 标签、准备度统计、回放任务），不经过流水线；
// 权重建议通过页面上的“生成建议”按钮真实拟合。截图保存到 docs/receipts/m5-validation-<日期>/。
const now = new Date()
const day = now.toLocaleDateString('sv-SE')
const receipts = new URL(`../../../docs/receipts/m5-validation-${day}/`, import.meta.url).pathname

const DAY_MS = 86_400_000
const isoDay = (offset: number) =>
  new Date(now.getTime() + offset * DAY_MS).toISOString().slice(0, 10)

async function shot(page: Page, name: string) {
  mkdirSync(receipts, { recursive: true })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${receipts}${name}.png`, fullPage: true })
}

/** 有样本状态的夹具：两个方向、近 9 个月的影子与回放样本、准备度统计、回放任务 */
async function seed(slug: string, suffix: string) {
  const sql = fixtureDb()
  try {
    const [ws] = await sql`select id from organization where slug = ${slug}`
    if (!ws) throw new Error('workspace missing')
    const workspaceId = ws.id as string
    const [kitchen] = await sql`insert into direction (id, workspace_id, name, marketplaces)
      values (gen_random_uuid(), ${workspaceId}, '厨房收纳', '{ebay-us}'::text[]) returning id`
    const [pets] = await sql`insert into direction (id, workspace_id, name, marketplaces)
      values (gen_random_uuid(), ${workspaceId}, '宠物用品', '{amazon-us}'::text[]) returning id`
    const [ebayCluster] =
      await sql`insert into cluster (id, workspace_id, direction_id, marketplace, name)
      values (gen_random_uuid(), ${workspaceId}, ${kitchen?.id}, 'ebay-us', '冰箱收纳盒') returning id`
    const [amazonCluster] =
      await sql`insert into cluster (id, workspace_id, direction_id, marketplace, name)
      values (gen_random_uuid(), ${workspaceId}, ${pets?.id}, 'amazon-us', '慢食碗') returning id`
    for (let i = 0; i < 6; i += 1) {
      const [p] = await sql`insert into marketplace_product (id, marketplace, platform_id, title)
        values (gen_random_uuid(), 'amazon-us', ${`B0E2E${suffix}${i}`}, ${`慢食碗 ${i}`}) returning id`
      await sql`insert into cluster_member (id, workspace_id, cluster_id, product_id, method, confidence)
        values (gen_random_uuid(), ${workspaceId}, ${amazonCluster?.id}, ${p?.id}, 'manual', 1)`
    }

    const signals = ['market-demand', 'growth-season', 'peer-spread'] as const
    const insertRec = async (
      i: number,
      kind: 'shadow' | 'replay',
      frozenOffset: number,
      label: { outcome: 'hit' | 'miss' | 'insufficient'; labeledOffset: number } | null,
    ) => {
      const demand = 20 + ((i * 37) % 71)
      const other = 30 + ((i * 53) % 41)
      const amazon = kind === 'replay'
      const inputs = {
        dimensions: {
          'market-demand': { score: demand },
          'peer-spread': { score: other },
          competition: { score: 100 - other },
          compliance: { score: 40 + (i % 5) * 5 },
        },
      }
      const [rec] = await sql`insert into recommendation
        (id, workspace_id, cluster_id, direction_id, frozen_on, marketplace, signal_type, score, grade,
         confidence, setting_version, inputs, sample_kind)
        values (gen_random_uuid(), ${workspaceId}, ${amazon ? amazonCluster?.id : ebayCluster?.id},
          ${amazon ? pets?.id : kitchen?.id}, ${isoDay(frozenOffset)}, ${amazon ? 'amazon-us' : 'ebay-us'},
          ${amazon ? 'market-demand' : (signals[i % 3] as string)}, 60, 'caution', 0.5, 1, ${sql.json(inputs)}, ${kind})
        returning id`
      // 同时写入 T+14 / T+60 标签，待打标签数只反映最近冻结的推荐
      if (label)
        for (const [w, shift] of [
          [14, -16],
          [30, 0],
          [60, 30],
        ] as const)
          await sql`insert into recommendation_label
            (id, workspace_id, recommendation_id, window_days, outcome, labeled_at)
            values (gen_random_uuid(), ${workspaceId}, ${rec?.id}, ${w}, ${label.outcome},
              ${new Date(now.getTime() + (label.labeledOffset + shift) * DAY_MS)})`
    }
    // 影子推荐：近 9 个月逐月到期打标签；需求分 ≥ 55 命中
    for (let i = 0; i < 110; i += 1) {
      const labeledOffset = -270 + i * 2
      const demand = 20 + ((i * 37) % 71)
      const outcome = i % 17 === 0 ? 'insufficient' : demand >= 55 ? 'hit' : 'miss'
      await insertRec(i, 'shadow', labeledOffset - 30, { outcome, labeledOffset })
    }
    // Keepa 回放样本：集中在 3 个月前一次回放
    for (let i = 200; i < 236; i += 1) {
      const demand = 20 + ((i * 37) % 71)
      await insertRec(i, 'replay', -200 + (i - 200), {
        outcome: demand >= 55 ? 'hit' : 'miss',
        labeledOffset: -95,
      })
    }
    // 已到期未打标签：冻结于 15–40 天前
    for (let i = 300; i < 312; i += 1) await insertRec(i, 'shadow', -15 - (i % 26), null)

    const computedOn = isoDay(-1)
    const stat = async (
      directionId: string,
      marketplace: string,
      signal: string,
      v: {
        shadow: number
        replay: number
        hits: number
        eff: number
        lower: number | null
        base: number | null
        level: string
      },
    ) =>
      sql`insert into readiness_stat (id, workspace_id, marketplace, direction_id, signal_type, computed_on,
          shadow_count, replay_count, hit_count, effective_samples, wilson_lower, baseline, level)
        values (gen_random_uuid(), ${workspaceId}, ${marketplace}, ${directionId}, ${signal}, ${computedOn},
          ${v.shadow}, ${v.replay}, ${v.hits}, ${v.eff}, ${v.lower}, ${v.base}, ${v.level})`
    await stat(kitchen?.id, 'ebay-us', 'market-demand', {
      shadow: 34,
      replay: 0,
      hits: 17,
      eff: 34,
      lower: 0.339,
      base: 0.22,
      level: 'observation',
    })
    await stat(kitchen?.id, 'ebay-us', 'growth-season', {
      shadow: 31,
      replay: 0,
      hits: 14,
      eff: 31,
      lower: 0.288,
      base: 0.22,
      level: 'observation',
    })
    await stat(kitchen?.id, 'ebay-us', 'peer-spread', {
      shadow: 13,
      replay: 0,
      hits: 5,
      eff: 13,
      lower: 0.177,
      base: 0.22,
      level: 'cold-start',
    })
    await stat(pets?.id, 'amazon-us', 'market-demand', {
      shadow: 0,
      replay: 36,
      hits: 18,
      eff: 18,
      lower: 0.29,
      base: null,
      level: 'cold-start',
    })

    const replay = async (
      offsetHours: number,
      status: string,
      errorCode: string | null,
      ok: number,
      nodeOffset: number,
    ) => {
      const nodeDate = isoDay(nodeOffset)
      const scope = {
        role: 'replay',
        workspaceId,
        directionId: pets?.id,
        nodeDate,
        beforeDays: 30,
        frozenOn: isoDay(nodeOffset - 30),
        asins: { 'amazon-us': Array.from({ length: 6 }, (_, i) => `B0E2E${suffix}${i}`) },
        estimatedTokens: 6,
      }
      const [parent] =
        await sql`insert into sync_run (id, source_id, data_kind, marketplace, scope, trigger, status, planned,
          ok_count, error_code, started_at, finished_at)
        values (gen_random_uuid(), 'keepa', 'rank-history', 'amazon-us', ${sql.json(scope)}, 'replay', ${status},
          6, ${ok}, ${errorCode}, ${new Date(now.getTime() - offsetHours * 3_600_000)},
          ${status === 'succeeded' || status === 'failed' ? new Date(now.getTime() - offsetHours * 3_600_000 + 600_000) : null})
        returning id`
      // 成功的回放带一条已取历史的批次记录（与 runSyncTask 写入的形状一致）
      if (status === 'succeeded')
        await sql`insert into sync_run (id, source_id, data_kind, marketplace, scope, trigger, status, planned, ok_count, started_at)
          values (gen_random_uuid(), 'keepa', 'rank-history', 'amazon-us',
            ${sql.json({ replayId: parent?.id, ids: scope.asins['amazon-us'] })}, 'replay', 'succeeded', 6, 6,
            ${new Date(now.getTime() - offsetHours * 3_600_000 + 60_000)})`
    }
    await replay(2200, 'succeeded', null, 6, -120)
    await replay(30, 'failed', 'KEEPA_API_KEY_MISSING', 0, -60)
    await replay(5, 'deferred', 'BUDGET_SAFETY_LINE', 0, -45)
    await replay(1, 'running', null, 0, -40)
    return { workspaceId }
  } finally {
    await sql.end()
  }
}

test('算法验证：冷启动说明、有样本时的矩阵/曲线/构成、权重建议与回放', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await simulateClientIp(page)
  await stubTurnstile(page)
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
  await register(page, `validation-${suffix.toLowerCase()}@example.com`)
  const base = new URL(page.url()).pathname.replace(/\/$/, '')
  const slug = base.split('/').pop() as string

  // 冷启动：说明需要的样本数与预计时间，不画示例曲线
  await page.goto(`${base}/validation`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('cold-start')).toContainText('至少 20 个有效样本')
  await expect(page.getByTestId('cold-start-eta')).toContainText('暂无法估算时间')
  await expect(page.locator('[data-slot="chart"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="chart-empty"]')).toHaveCount(1)
  await page.getByRole('button', { name: '生成建议' }).click()
  await expect(page.getByTestId('propose-reason')).toContainText('少于拟合下限 50')
  await shot(page, '01-cold-start')

  // 有样本：直接写入夹具后刷新
  await seed(slug, suffix)
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('cold-start')).toHaveCount(0)
  await expect(page.getByTestId('readiness-cell')).toHaveCount(4)
  await expect(page.locator('[data-slot="chart"]')).toHaveCount(1)
  await expect(page.getByTestId('pending-total')).not.toHaveText('0')
  const rows = page.getByTestId('replay-row')
  await expect(rows).toHaveCount(4)
  await expect(page.locator('[data-testid="replay-row"][data-status="failed"]')).toContainText(
    '未配置 Keepa 凭据',
  )
  await expect(page.locator('[data-testid="replay-row"][data-status="deferred"]')).toContainText(
    '额度安全线',
  )
  await expect(page.locator('[data-testid="replay-row"][data-status="queued"]')).toContainText(
    '排队',
  )
  await expect(page.getByTestId('replay-preview')).toContainText('预计 6 个商品')

  await page.getByRole('button', { name: '生成建议' }).click()
  const suggestion = page.getByTestId('suggestion')
  await expect(suggestion).toBeVisible()
  await expect(suggestion.getByRole('button', { name: '采用并生成新版本' })).toBeVisible()
  await shot(page, '02-with-samples')
  await page.getByLabel('按月命中率曲线').hover({ position: { x: 560, y: 140 } })
  await page.waitForTimeout(400)
  await page
    .getByRole('heading', { name: '按月命中率（T+30）' })
    .locator('xpath=ancestor::section[1]')
    .screenshot({ path: `${receipts}03-hit-rate-hover.png` })

  await suggestion.getByRole('button', { name: '采用并生成新版本' }).click()
  await expect(page.getByText('生成评分设置版本 2')).toBeVisible()

  // 本地 dev 为 Cloudflare 目标，未装配回放队列：入口说明原因并停用按钮（参数校验由集成测试覆盖）
  await expect(page.getByTestId('replay-unavailable')).toBeVisible()
  await expect(page.getByRole('button', { name: '发起回放' })).toBeDisabled()

  // 数据中心：评分维度旁的回测命中率
  await page.goto(`${base}/data`)
  await page.waitForLoadState('networkidle')
  // 等水合完成后标签切换才生效
  await expect(async () => {
    await page.getByRole('tab', { name: '评分维度管理' }).click()
    await expect(page.getByRole('tab', { name: '评分维度管理' })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 1000 },
    )
  }).toPass()
  await expect(page.getByTestId('backtest-market-demand')).toContainText('下界')
  await expect(page.getByTestId('backtest-profit')).toContainText('无样本')
  await expect(page.getByText('当前版本 2')).toBeVisible()
  await shot(page, '04-data-center-backtest')
})
