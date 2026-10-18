import type { Page } from '@playwright/test'
import {
  adminIdentity,
  ensureRegisteredAccount,
  evidence,
  expect,
  login,
  query,
  requireEnv,
  sessionUser,
  sqlLiteral,
  test,
} from './support.ts'

const fixtureName = 'Staging acceptance dedicated user'
const banReason = 'staging-acceptance:admin:ban'
const unbanReason = 'staging-acceptance:admin:unban'
const topUpReason = 'staging-acceptance:admin:top-up:v1'
const announcement = 'Staging acceptance: temporary announcement verification'
const amount = 25
type IdRow = Record<string, unknown> & { id: string }

async function latestAudit(actorId: string, action: string, targetId: string, extra = '') {
  const rows = await query<IdRow>(`select id from audit_log
    where actor_user_id=${sqlLiteral(actorId)} and action=${sqlLiteral(action)}
    and target_id=${sqlLiteral(targetId)} ${extra} order by id desc limit 1`)
  expect(rows, `Missing audit for ${action}`).toHaveLength(1)
  return (rows[0] as IdRow).id
}

async function changeBan(page: Page, banned: boolean) {
  await page.getByLabel('Reason', { exact: true }).fill(banned ? banReason : unbanReason)
  await page.getByLabel('I confirm this user status change', { exact: true }).check()
  await page.getByRole('button', { name: banned ? 'Ban user' : 'Unban user', exact: true }).click()
  await expect(
    page.getByText(banned ? 'User banned.' : 'User unbanned.', { exact: true }),
  ).toBeVisible()
}

test('Admin 6.1: dedicated user, ban, unban, impersonation, credits and restored setting', async ({
  page,
  browser,
}) => {
  requireEnv(['STAGING_TEST_USER_EMAIL', 'STAGING_TEST_USER_PASSWORD', 'NEON_READONLY_URL'])
  const email = (process.env.STAGING_TEST_USER_EMAIL ?? '').trim().toLowerCase()
  expect(
    email === process.env.STAGING_USER_EMAIL?.trim().toLowerCase(),
    'Dedicated test user must differ from the ordinary AI acceptance user',
  ).toBe(false)
  await login(page, 'admin')
  const admin = adminIdentity(await sessionUser(page), email)
  const actorId = admin.id
  const readTarget = () =>
    query<IdRow & { role: string; banned: boolean; is_fixture: boolean }>(
      `select id, role, coalesce(banned,false) as banned, name=${sqlLiteral(fixtureName)} as is_fixture
      from "user" where email=${sqlLiteral(email)}`,
    )
  // 注册放在独立 Context，保留当前管理员的内存会话。
  const registration = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
  let target: Awaited<ReturnType<typeof readTarget>>[number]
  try {
    const result = await ensureRegisteredAccount(
      await registration.newPage(),
      async () => (await readTarget())[0],
      email,
      process.env.STAGING_TEST_USER_PASSWORD ?? '',
      fixtureName,
    )
    target = result.account
  } finally {
    await registration.close()
  }
  adminIdentity(admin, email, target.id)
  expect(target?.is_fixture, 'Existing account must be the dedicated acceptance fixture').toBe(true)
  expect(target?.role).toBe('user')
  const userId = (target as IdRow).id
  const [workspace] = await query<IdRow>(`select o.id from organization o join member m
    on m.organization_id=o.id where m.user_id=${sqlLiteral(userId)} and m.role='owner'
    and o.is_personal=true and o.deleted_at is null`)
  expect(Boolean(workspace), 'Dedicated user personal workspace missing').toBe(true)
  const workspaceId = (workspace as IdRow).id
  await evidence('admin-dedicated-user', { userId, workspaceId, status: 'verified-dedicated-user' })

  await test.step('search and ban', async () => {
    await page.goto('/admin/users')
    // 按 ID 搜索可以验收搜索功能，并避免失败报告把邮箱当作 selector 展示。
    await page.getByLabel('Search users', { exact: true }).fill(userId)
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.locator(`a[href="/admin/users/${userId}"]`).click()
    await expect(page.getByRole('heading', { name: 'User details', exact: true })).toBeVisible()
    if (!target?.banned) await changeBan(page, true)
    const [saved] = await readTarget()
    expect(saved?.banned).toBe(true)
    const auditId = await latestAudit(
      actorId,
      'user.banned',
      userId,
      `and meta->>'reason'=${sqlLiteral(banReason)}`,
    )
    await evidence('admin-ban', { userId, status: 'banned', auditId })
  })

  await test.step('unban', async () => {
    await changeBan(page, false)
    expect((await readTarget())[0]?.banned).toBe(false)
    const auditId = await latestAudit(
      actorId,
      'user.unbanned',
      userId,
      `and meta->>'reason'=${sqlLiteral(unbanReason)}`,
    )
    await evidence('admin-unban', { userId, status: 'active', auditId })
  })

  await test.step('impersonate and end impersonation', async () => {
    await page.getByRole('button', { name: 'Impersonate user', exact: true }).click()
    const banner = page.getByRole('status', { name: 'Impersonation', exact: true })
    try {
      await expect(banner).toBeVisible()
      const auditId = await latestAudit(
        actorId,
        'user.impersonation.started',
        userId,
        `and meta->>'actualAdminId'=${sqlLiteral(actorId)}`,
      )
      await evidence('admin-impersonation-started', {
        userId,
        actorId,
        status: 'impersonating',
        auditId,
      })
    } finally {
      // 即使证据核验失败，也通过产品退出入口恢复管理员身份。
      if (await banner.isVisible()) {
        await banner.getByRole('button', { name: 'Stop impersonating', exact: true }).click()
        await expect(banner).toHaveCount(0)
      }
    }
    const auditId = await latestAudit(
      actorId,
      'user.impersonation.ended',
      userId,
      `and meta->>'actualAdminId'=${sqlLiteral(actorId)}`,
    )
    await evidence('admin-impersonation-ended', {
      userId,
      actorId,
      status: 'admin-restored',
      auditId,
    })
  })

  await test.step('top up once across reruns', async () => {
    const readAdjustment = () =>
      query<IdRow & { adjustment_id: string }>(`select id, target_id as adjustment_id
      from audit_log where workspace_id=${sqlLiteral(workspaceId)} and action='credits.adjust'
      and meta->'input'->>'kind'='grant' and meta->'input'->>'reason'=${sqlLiteral(topUpReason)}
      order by id`)
    if ((await readAdjustment()).length === 0) {
      await page.goto(`/admin/credits?workspaceId=${workspaceId}`)
      await expect
        .poll(async () => {
          await page.getByLabel('Amount', { exact: true }).fill('')
          await page.getByLabel('Amount', { exact: true }).fill(String(amount))
          await page.getByLabel('Reason', { exact: true }).fill('')
          await page.getByLabel('Reason', { exact: true }).fill(topUpReason)
          return page.getByRole('button', { name: 'Add credits', exact: true }).isEnabled()
        })
        .toBe(true)
      await page.getByRole('button', { name: 'Add credits', exact: true }).click()
      await expect.poll(async () => (await readAdjustment()).length).toBe(1)
    }
    const adjustments = await readAdjustment()
    expect(adjustments, 'Acceptance top-up must be issued only once').toHaveLength(1)
    const adjustment = adjustments[0] as IdRow & { adjustment_id: string }
    const grants = await query<IdRow & { amount: number }>(`select id, amount from credit_grant
      where workspace_id=${sqlLiteral(workspaceId)} and source='admin'
      and source_ref=${sqlLiteral(adjustment.adjustment_id)}`)
    expect(grants).toHaveLength(1)
    expect(grants[0]?.amount).toBe(amount)
    await evidence('admin-top-up', {
      userId,
      workspaceId,
      auditId: adjustment.id,
      adjustmentId: adjustment.adjustment_id,
      grantId: grants[0]?.id,
      amount,
      status: 'applied-once',
    })
  })

  await test.step('change announcement and restore original', async () => {
    await page.goto('/admin/settings')
    const form = page.getByRole('form', { name: 'Runtime settings', exact: true })
    await expect(form).toBeVisible()
    let original = await form.getByLabel('Site announcement', { exact: true }).inputValue()
    // 上次进程在恢复前中止时，用该脚本变更审计中的旧值恢复，不把临时公告当作原值。
    if (original === announcement) {
      const [previous] = await query<
        Record<string, unknown> & { original: string }
      >(`select meta->>'oldValue' as original
        from audit_log where actor_user_id=${sqlLiteral(actorId)} and action='setting.updated'
        and target_id='site.announcement' and meta->>'newValue'=${sqlLiteral(announcement)}
        and meta->>'oldValue'<>${sqlLiteral(announcement)} order by id desc limit 1`)
      expect(Boolean(previous), 'Missing original announcement recovery audit').toBe(true)
      original = previous?.original ?? ''
    }
    let changedAuditId: string | undefined
    try {
      await form.getByLabel('Site announcement', { exact: true }).fill(announcement)
      await form.getByRole('button', { name: 'Save settings', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Saved. Changes apply' }),
      ).toBeVisible()
      changedAuditId = await latestAudit(
        actorId,
        'setting.updated',
        'site.announcement',
        `and meta->>'newValue'=${sqlLiteral(announcement)}`,
      )
    } finally {
      await page.goto('/admin/settings')
      const restore = page.getByRole('form', { name: 'Runtime settings', exact: true })
      await restore.getByLabel('Site announcement', { exact: true }).fill(original)
      await restore.getByRole('button', { name: 'Save settings', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Saved. Changes apply' }),
      ).toBeVisible()
    }
    const restoredAuditId = await latestAudit(
      actorId,
      'setting.updated',
      'site.announcement',
      `and meta->>'oldValue'=${sqlLiteral(announcement)} and meta->>'newValue'=${sqlLiteral(original)}`,
    )
    const [saved] = await query<
      Record<string, unknown>
    >(`select value=${sqlLiteral(JSON.stringify(original))}::jsonb as restored
      from setting where key='site.announcement'`)
    expect(saved?.restored).toBe(true)
    await evidence('admin-setting', {
      settingKey: 'site.announcement',
      changedAuditId,
      restoredAuditId,
      status: 'restored',
    })
  })
})
