import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { capture, grant, hold } from '@product-res/credits'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { actionDb, actor } from './billing-actions-helper.ts'
import { fixtureDb, register, simulateClientIp, uiText } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

/** 调用浏览器实际导入的 Start 客户端桩，POST 仍进入真实服务端中间件与 handler。 */
async function checkout(page: Page, slug: string) {
  return page.evaluate(
    async ({ slug, priceId, idempotencyKey }) => {
      const source = '/src/features/billing/customer.functions.ts'
      const { checkoutCustomer } = await import(source)
      try {
        return {
          rejected: false,
          value: await checkoutCustomer({
            data: { slug, provider: 'stripe', planPriceId: priceId, idempotencyKey },
          }),
        }
      } catch (error) {
        return {
          rejected: true,
          message: error instanceof Error ? error.message : JSON.stringify(error),
        }
      }
    },
    { slug, priceId: randomUUID(), idempotencyKey: randomUUID() },
  )
}

async function makeAdmin(page: Page) {
  await simulateClientIp(page)
  await stubTurnstile(page)
  const email = `admin-users-${randomUUID()}@example.com`
  await register(page, email, 'Platform admin')
  const identity = await actor(email)
  const sql = fixtureDb()
  try {
    await sql`update "user" set role='admin' where id=${identity.userId}`
  } finally {
    await sql.end()
  }
  return { ...identity, email }
}

async function banForm(page: Page, reason: string, button: string) {
  await page.getByLabel(uiText('admin_reason'), { exact: true }).fill(reason)
  await page.getByLabel(uiText('admin_i_confirm_this_user_status_change')).check()
  await page.getByRole('button', { name: button, exact: true }).click()
}

test('用户封禁后旧会话结账立即被拒绝，解封与自封禁约束可用', async ({ page, browser }) => {
  const admin = await makeAdmin(page)
  const context = await browser.newContext()
  const targetPage = await context.newPage()
  const sql = fixtureDb()
  try {
    await simulateClientIp(targetPage)
    await stubTurnstile(targetPage)
    const email = `ban-target-${randomUUID()}@example.com`
    await register(targetPage, email)
    const target = await actor(email)
    await page.goto('/admin/users')
    await page.getByLabel(uiText('admin_search_users')).fill(email)
    await page.getByRole('button', { name: uiText('admin_apply'), exact: true }).click()
    await page.getByRole('link', { name: email, exact: true }).click()
    await expect(page.getByText('credential', { exact: true })).toBeVisible()
    await banForm(page, 'Abuse investigation', uiText('admin_ban_user'))
    await expect(page.getByText(uiText('admin_user_banned'), { exact: true })).toBeVisible()
    expect((await checkout(targetPage, target.slug)).rejected).toBe(true)
    expect(
      await sql`select id from purchase where workspace_id=${target.workspaceId}`,
    ).toHaveLength(0)
    await banForm(page, 'Appeal accepted', uiText('admin_unban_user'))
    await expect(page.getByText(uiText('admin_user_unbanned'), { exact: true })).toBeVisible()
    const audit =
      await sql`select actor_user_id,action,meta from audit_log where target_id=${target.userId} and action in ('user.banned','user.unbanned') order by created_at`
    expect(audit).toMatchObject([
      {
        actor_user_id: admin.userId,
        action: 'user.banned',
        meta: { reason: 'Abuse investigation' },
      },
      { actor_user_id: admin.userId, action: 'user.unbanned', meta: { reason: 'Appeal accepted' } },
    ])
    await page.goto(`/admin/users/${admin.userId}`)
    await page.getByLabel(uiText('admin_reason'), { exact: true }).fill('Self ban')
    await page.getByLabel(uiText('admin_i_confirm_this_user_status_change')).check()
    await expect(
      page.getByRole('button', { name: uiText('admin_ban_user'), exact: true }),
    ).toBeDisabled()
    await expect(
      page.getByRole('button', { name: uiText('admin_impersonate_user') }),
    ).toBeDisabled()
    const direct = await page.request.post('/api/auth/admin/ban-user', {
      data: { userId: admin.userId, banReason: 'Self ban' },
    })
    expect(direct.status()).toBe(403)
  } finally {
    await sql.end()
    await context.close()
  }
})

test('模拟登录横幅、退出与双重身份审计，真实结账及其他敏感操作被拒绝', async ({
  page,
  browser,
}) => {
  const admin = await makeAdmin(page)
  const context = await browser.newContext()
  const targetPage = await context.newPage()
  const sql = fixtureDb()
  try {
    await simulateClientIp(targetPage)
    await stubTurnstile(targetPage)
    const email = `impersonate-target-${randomUUID()}@example.com`
    await register(targetPage, email)
    const target = await actor(email)
    await page.goto(`/admin/users/${target.userId}`)
    await page.getByRole('button', { name: uiText('admin_impersonate_user') }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${target.slug}$`))
    const banner = page.getByRole('status', { name: uiText('admin_impersonation') })
    await expect(banner).toContainText(email)
    await expect(banner).toContainText(admin.email)
    const result = await checkout(page, target.slug)
    expect(result.rejected).toBe(true)
    expect(result.message).toContain('Sensitive actions')
    const refundAndDeletion = await page.evaluate(
      async ({ slug }) => {
        const refundSource = '/src/features/billing/refund.functions.ts'
        const deletionSource = '/src/features/deletion/deletion.functions.ts'
        const { requestCustomerRefund } = await import(refundSource)
        const { removeAccount } = await import(deletionSource)
        const messages: string[] = []
        for (const action of [
          () =>
            requestCustomerRefund({
              data: {
                slug,
                paymentId: crypto.randomUUID(),
                reason: 'Test',
                contactEmail: 'test@example.com',
              },
            }),
          () => removeAccount(),
        ]) {
          try {
            await action()
            messages.push('allowed')
          } catch (error) {
            messages.push(error instanceof Error ? error.message : String(error))
          }
        }
        return messages
      },
      { slug: target.slug },
    )
    expect(refundAndDeletion).toEqual([
      expect.stringContaining('Sensitive actions'),
      expect.stringContaining('Sensitive actions'),
    ])
    expect(
      (
        await page.request.post('/api/auth/change-password', {
          data: { currentPassword: 'correct-horse-battery', newPassword: 'different-password-123' },
        })
      ).status(),
    ).toBe(403)
    expect((await page.request.get('/admin/users')).status()).toBe(404)
    await page.goto('/account')
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: uiText('admin_stop_impersonating') }).click()
    await expect(page).toHaveURL(/\/admin\/users\?offset=0$/)
    await expect(page.getByRole('status', { name: uiText('admin_impersonation') })).toHaveCount(0)
    const audit =
      await sql`select actor_user_id,action,meta from audit_log where target_id=${target.userId} and action like 'user.impersonation.%' order by created_at`
    expect(audit).toMatchObject([
      {
        actor_user_id: admin.userId,
        action: 'user.impersonation.started',
        meta: { userId: target.userId, actualAdminId: admin.userId },
      },
      {
        actor_user_id: admin.userId,
        action: 'user.impersonation.ended',
        meta: { userId: target.userId, actualAdminId: admin.userId },
      },
    ])
    expect(
      await sql`select id from purchase where workspace_id=${target.workspaceId}`,
    ).toHaveLength(0)
  } finally {
    await sql.end()
    await context.close()
  }
})

test('空间详情展示积分、重叠订阅，并恢复原 owner 的访问', async ({ page, browser }) => {
  const admin = await makeAdmin(page)
  const context = await browser.newContext()
  const ownerPage = await context.newPage()
  const sql = fixtureDb()
  const db = actionDb()
  const workspaceId = randomUUID()
  const slug = `restore-${workspaceId}`
  try {
    await simulateClientIp(ownerPage)
    await stubTurnstile(ownerPage)
    const email = `restore-owner-${randomUUID()}@example.com`
    await register(ownerPage, email)
    const owner = await actor(email)
    await sql`insert into organization(id,name,slug) values(${workspaceId},'Recoverable workspace',${slug})`
    await sql`insert into member(id,organization_id,user_id,role) values(${randomUUID()},${workspaceId},${owner.userId},'owner')`
    await sql`insert into audit_log(id,actor_user_id,workspace_id,action,target_type,target_id,meta) values(${randomUUID()},${owner.userId},${workspaceId},'workspace.deleted','organization',${workspaceId},${sql.json({ originalOwnerUserIds: [owner.userId] })}::jsonb)`
    const planId = randomUUID()
    const priceId = randomUUID()
    await sql`insert into plan(id,key,name,type,credits,features,sort,active) values(${planId},${planId},'Overlap fixture','subscription',0,${sql.json({ ...DEFAULT_FREE_FEATURES })}::jsonb,123,false)`
    await sql`insert into plan_price(id,plan_id,provider,provider_price_id,interval,amount,currency,active) values(${priceId},${planId},'stripe',${priceId},'month',0,'usd',false)`
    for (const id of [randomUUID(), randomUUID()])
      await sql`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,current_period_start,current_period_end,last_event_at) values(${id},${workspaceId},${planId},${priceId},'stripe',${id},'canceled',now(),now()+interval '1 day',now())`
    await grant(db, { workspaceId, source: 'admin', sourceRef: workspaceId, amount: 100 })
    const reserved = await hold(db, {
      workspaceId,
      userId: owner.userId,
      amount: 10,
      refType: 'ai_message',
      refId: randomUUID(),
    })
    const consumed = await hold(db, {
      workspaceId,
      userId: owner.userId,
      amount: 90,
      refType: 'ai_message',
      refId: randomUUID(),
    })
    await capture(db, {
      workspaceId,
      holdId: consumed.id,
      actualAmount: 100,
      overage: { maxRatio: 0, maxCredits: 0, dailyBudgetPerWorkspace: 0 },
    })
    await sql`update organization set deleted_at=now() where id=${workspaceId}`
    await sql`delete from member where organization_id=${workspaceId}`
    await ownerPage.goto(`/app/${slug}`)
    await expect(
      ownerPage.getByRole('heading', { name: uiText('app_workspace_not_found') }),
    ).toBeVisible()
    await page.goto('/admin/workspaces')
    await page.getByLabel(uiText('admin_search_workspaces')).fill(workspaceId)
    await page.getByLabel(uiText('admin_status'), { exact: true }).selectOption('deleted')
    await page.getByRole('button', { name: uiText('admin_apply'), exact: true }).click()
    await page.getByRole('link', { name: 'Recoverable workspace' }).click()
    await expect(
      page.locator('strong').filter({ hasText: uiText('admin_overlapping_period') }),
    ).toHaveCount(2)
    await expect(page.locator('dl')).toContainText(`${uiText('admin_held_credits')}10`)
    await expect(page.locator('dl')).toContainText(`${uiText('admin_credit_debt')}10`)
    await expect(page.getByRole('heading', { name: uiText('admin_credit_batches') })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: uiText('admin_recent_credit_ledger') }),
    ).toBeVisible()
    await page.getByLabel(uiText('admin_i_confirm_restoring_this_workspace')).check()
    await page.getByRole('button', { name: uiText('admin_restore_workspace') }).click()
    await expect(
      page.getByText(uiText('admin_workspace_restored_original_owners_can_access_it_again')),
    ).toBeVisible()
    await ownerPage.goto(`/app/${slug}`)
    await expect(ownerPage.getByTestId('workspace-name')).toHaveText('Recoverable workspace')
    const [audit] =
      await sql`select actor_user_id from audit_log where workspace_id=${workspaceId} and action='workspace.restored'`
    expect(audit?.actor_user_id).toBe(admin.userId)
    expect(reserved.amount).toBe(10)
  } finally {
    await db.$client.end()
    await sql.end()
    await context.close()
  }
})
