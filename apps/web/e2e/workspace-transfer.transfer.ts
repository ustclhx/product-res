import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import {
  activateWorkspaceSlug,
  createTeamWorkspace,
  fixtureDb,
  register,
  simulateClientIp,
  uiText,
  waitForHydration,
} from './fixtures.ts'

// 独立配置启动真实 jobs Workflow；不拦截流转 API，也不直接写流转状态。
test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
})

async function personalWorkspace(page: Page) {
  const key = randomUUID().slice(0, 8)
  await register(page, `transfer-${key}@example.com`, `流转验收${key}`)
  const slug = new URL(page.url()).pathname.split('/')[2] as string
  const sql = fixtureDb()
  try {
    const [workspace] = await sql`select id, name from organization where slug = ${slug}`
    if (!workspace) throw new Error('Personal workspace missing')
    return { id: String(workspace.id), name: String(workspace.name), slug, key }
  } finally {
    await sql.end()
  }
}

async function directionForm(page: Page, slug: string, name: string) {
  await page.goto(`/app/${slug}/follow/directions`)
  await waitForHydration(page)
  await page.getByRole('button', { name: '新建方向', exact: true }).click()
  const form = page.getByRole('form', { name: '选品方向' })
  await form.getByLabel('方向名称').fill(name)
  await form.getByLabel('eBay US').check()
  await form.getByLabel('关键词').fill(`fixture-${name}`)
  return form
}

async function createDirection(page: Page, slug: string, name: string) {
  const form = await directionForm(page, slug, name)
  await form.getByRole('button', { name: '保存', exact: true }).click()
  const card = page
    .getByTestId('direction-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(card).toBeVisible()
  return card
}

async function upgrade(page: Page, slug: string, targetSlug: string) {
  await page.goto(`/app/${slug}/settings`)
  await waitForHydration(page)
  await page.getByRole('button', { name: '升级为团队空间…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '升级为团队空间', exact: true })
  await expect(dialog.getByTestId('upgrade-moves')).toBeVisible()
  return {
    dialog,
    async confirm() {
      await dialog.getByLabel(uiText('workspace_team_name'), { exact: true }).fill('升级验收团队')
      await dialog.getByLabel(uiText('workspace_team_slug'), { exact: true }).fill(targetSlug)
      await dialog.getByRole('checkbox').check()
      await dialog.getByRole('button', { name: '确认升级', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/app/${slug}/settings/transfers/[0-9a-f-]{36}$`))
      return new URL(page.url()).pathname.split('/').pop() as string
    },
  }
}

async function completed(page: Page) {
  await expect(page.getByTestId('transfer-detail').locator('[data-status="completed"]')).toHaveText(
    '已完成',
    { timeout: 90_000 },
  )
  const id = new URL(page.url()).pathname.split('/').pop() as string
  const sql = fixtureDb()
  try {
    const batches = await sql`select status from workspace_transfer_batch where transfer_id = ${id}`
    expect(batches.length, '真实 Workflow 已创建并执行批次').toBeGreaterThan(0)
    expect(batches.every((batch) => batch.status === 'done')).toBe(true)
    const [maps] =
      await sql`select count(*)::int as n from workspace_transfer_id_map where transfer_id = ${id} and action <> 'planned'`
    expect(maps?.n).toBeGreaterThan(0)
  } finally {
    await sql.end()
  }
  await page.screenshot({ path: test.info().outputPath('completed.png'), fullPage: true })
}

test('个人空间升级：预览、真实移动、团队可见且个人空间清空', async ({ page }) => {
  const ws = await personalWorkspace(page)
  const targetSlug = `upgrade-${ws.key}`
  const card = await createDirection(page, ws.slug, '厨房收纳')
  const seller = card.getByRole('form', { name: '为厨房收纳添加种子店铺' })
  await seller.getByLabel('卖家 ID').fill(`transfer-seller-${ws.key}`)
  await seller.getByRole('button', { name: '添加种子店铺' }).click()
  await expect(card.getByText('对标店铺池（1）')).toBeVisible()
  await createDirection(page, ws.slug, '宠物用品')

  const preview = await upgrade(page, ws.slug, targetSlug)
  const moves = preview.dialog.getByTestId('upgrade-moves')
  await moves.locator('summary').filter({ hasText: '方向' }).click()
  await expect(
    moves
      .locator('li')
      .filter({ has: page.getByText('方向', { exact: true }) })
      .last(),
  ).toContainText('2')
  await expect(moves).toContainText('方向卖家')
  const stays = preview.dialog.getByTestId('upgrade-stays')
  for (const text of ['积分', '订阅与支付', 'AI 对话', '文件', 'API Key', '审计记录'])
    await expect(stays).toContainText(text)
  await expect(preview.dialog.getByTestId('upgrade-activation')).toContainText('需要管理员另行开通')
  await page.screenshot({ path: test.info().outputPath('upgrade-preview.png'), fullPage: true })
  const transferId = await preview.confirm()
  await completed(page)

  const sql = fixtureDb()
  try {
    const [transfer] =
      await sql`select target_workspace_id as target from workspace_transfer where id = ${transferId}`
    const [source] =
      await sql`select count(*)::int as n from direction where workspace_id = ${ws.id}`
    expect(source?.n).toBe(0)
    const target =
      await sql`select name from direction where workspace_id = ${transfer?.target} order by name`
    expect(target.map((d) => d.name).sort()).toEqual(['厨房收纳', '宠物用品'].sort())
    const [seed] =
      await sql`select count(*)::int as n from direction_seller where workspace_id = ${transfer?.target}`
    expect(seed?.n).toBe(1)
    const [personal] = await sql`select is_personal from organization where id = ${ws.id}`
    expect(personal?.is_personal).toBe(true)
  } finally {
    await sql.end()
  }
  await page.getByRole('button', { name: '进入新团队空间', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/app/${targetSlug}$`))
  await activateWorkspaceSlug(targetSlug)
  await page.goto(`/app/${targetSlug}/follow/directions`)
  await expect(page.getByTestId('direction-card')).toHaveCount(2)
  await expect(page.getByText(`transfer-seller-${ws.key}`, { exact: true })).toBeVisible()
  await page.goto(`/app/${ws.slug}/follow/directions`)
  await expect(page.getByTestId('direction-card')).toHaveCount(0)
  await expect(page.getByText('还没有选品方向', { exact: true })).toBeVisible()
  await page.goto(`/app/${ws.slug}/settings/transfers`)
  await expect(page.getByRole('table', { name: '数据流转记录' })).toContainText('已完成')
})

test('多选复制：同名方向预览重命名，真实复制后源保持不变', async ({ page }) => {
  const ws = await personalWorkspace(page)
  await createDirection(page, ws.slug, '万圣节装饰')
  await createDirection(page, ws.slug, '一起复制')
  await createDirection(page, ws.slug, '仅源保留')
  const targetSlug = `copy-${ws.key}`
  await createTeamWorkspace(page, '复制验收团队', targetSlug)
  await createDirection(page, targetSlug, '万圣节装饰')
  const sql = fixtureDb()
  let targetId: string
  let original: unknown
  try {
    const [target] = await sql`select id from organization where slug = ${targetSlug}`
    targetId = String(target?.id)
    original =
      await sql`select id, name, keywords from direction where workspace_id = ${ws.id} order by id`
  } finally {
    await sql.end()
  }
  await page.goto(`/app/${ws.slug}/follow/directions`)
  await waitForHydration(page)
  await page
    .getByTestId('direction-card')
    .filter({ hasText: '万圣节装饰' })
    .getByTestId('transfer-select')
    .check()
  await page
    .getByTestId('direction-card')
    .filter({ hasText: '一起复制' })
    .getByTestId('transfer-select')
    .check()
  await expect(page.getByTestId('transfer-bar')).toContainText('已选 2 项')
  await page.getByRole('button', { name: '复制到空间…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '复制到其他空间' })
  await dialog.getByTestId('transfer-target').selectOption(targetId)
  await dialog.getByRole('button', { name: '预览', exact: true }).click()
  const renamed = `万圣节装饰（来自 ${ws.name}）`
  await expect(dialog.getByTestId('transfer-conflicts')).toContainText(renamed)
  await page.screenshot({ path: test.info().outputPath('copy-preview.png'), fullPage: true })
  await dialog.getByRole('button', { name: '确认复制', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/app/${ws.slug}/settings/transfers/[0-9a-f-]{36}$`))
  await completed(page)
  await expect(page.getByTestId('transfer-detail')).toContainText(renamed)
  const verify = fixtureDb()
  try {
    expect(
      await verify`select id, name, keywords from direction where workspace_id = ${ws.id} order by id`,
    ).toEqual(original)
    const target = await verify`select name from direction where workspace_id = ${targetId}`
    expect(target.map((d) => d.name).sort()).toEqual(['万圣节装饰', renamed, '一起复制'].sort())
  } finally {
    await verify.end()
  }
  await page.goto(`/app/${targetSlug}/follow/directions`)
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '万圣节装饰', exact: true })).toBeVisible()
  await expect(page.getByTestId('direction-card')).toHaveCount(3)
  await page.goto(`/app/${ws.slug}/follow/directions`)
  await expect(page.getByTestId('direction-card')).toHaveCount(3)
})

test('真实批次 running 时两边只读，拒绝陈旧表单写入，完成后恢复', async ({ page, context }) => {
  const ws = await personalWorkspace(page)
  await createDirection(page, ws.slug, '锁定中的方向')
  const stale = await context.newPage()
  const form = await directionForm(stale, ws.slug, '流转中不能创建')
  const targetSlug = `readonly-${ws.key}`
  const preview = await upgrade(page, ws.slug, targetSlug)
  const lock = fixtureDb()
  // 仅锁测试自建的方向：plan 可正常提交 running，真实移动 UPDATE 等待事务释放。
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked = () => {}
  const ready = new Promise<void>((resolve) => {
    locked = resolve
  })
  const holding = lock.begin(async (tx) => {
    await tx`select id from direction where workspace_id = ${ws.id} for update`
    locked()
    await gate
  })
  try {
    await ready
    await preview.confirm()
    await expect(page.getByTestId('transfer-detail').locator('[data-status="running"]')).toHaveText(
      '进行中',
      { timeout: 60_000 },
    )
    await expect(page.getByTestId('transfer-banner')).toContainText('只读')
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('正在进行数据流转')
    await page.screenshot({ path: test.info().outputPath('running-readonly.png'), fullPage: true })
    const target = await context.newPage()
    // 新团队尚未开通，只为检查工作台只读行为开通测试空间。
    await activateWorkspaceSlug(targetSlug)
    await target.goto(`/app/${targetSlug}/follow/directions`)
    await expect(target.getByTestId('transfer-banner')).toContainText('只读')
    await expect(target.getByRole('button', { name: '新建方向', exact: true })).toHaveCount(0)
    await target.close()
  } finally {
    release()
    await holding
    await lock.end()
    await stale.close()
  }
  await completed(page)
  await page.goto(`/app/${ws.slug}/follow/directions`)
  await expect(page.getByTestId('transfer-banner')).toHaveCount(0)
  await expect(page.getByTestId('direction-card')).toHaveCount(0)
  await createDirection(page, ws.slug, '流转后恢复创建')
  await page.goto(`/app/${targetSlug}/follow/directions`)
  await expect(page.getByTestId('transfer-banner')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '锁定中的方向', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '流转中不能创建', exact: true })).toHaveCount(0)
  await createDirection(page, targetSlug, '目标也恢复创建')
})
