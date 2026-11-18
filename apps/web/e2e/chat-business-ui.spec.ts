import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { chooseOption } from './select.ts'
import { stubTurnstile } from './turnstile.ts'

// 业务界面组件接线（add-ui-design-system tasks 8.6）：对话页的消息评分经真实的 setMessageFeedback
// 写入 ai_message_feedback；再次点击撤销、点踩展开文字反馈与原因并可修改，刷新后原因仍在，
// 后台反馈列表显示原因并可按原因筛选（add-subject-chat 9.x）；勾选共享对话后刷新仍在，
// 后台对已共享的条目显示对话片段（add-subject-chat 10.x）。回复直接写库，不依赖模型。

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
  }
})

const slugOf = (page: Page) => new URL(page.url()).pathname.split('/')[2] ?? ''

test('rates a reply, keeps the down-vote reason and shows it in the admin list', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const email = `chat-feedback-${randomUUID()}@example.com`
  await register(page, email)
  const slug = slugOf(page)
  const sql = fixtureDb()
  const conversationId = newId()
  const replyId = newId()
  try {
    const [row] = await sql`select o.id as workspace_id, u.id as user_id
      from organization o join "user" u on u.email = ${email} where o.slug = ${slug}`
    if (!row) throw new Error('Workspace fixture is missing')
    await sql`insert into ai_conversation (id, workspace_id, user_id, title, model_key)
      values (${conversationId}, ${row.workspace_id}, ${row.user_id}, 'Quarterly notes', '')`
    // 旧数据的回复 ID 更早，同一条 INSERT 让问答的 created_at 也相同。
    await sql`insert into ai_message (id, workspace_id, conversation_id, role, parts, status) values
      (${newId()}, ${row.workspace_id}, ${conversationId}, 'user', ${sql.json([{ type: 'text', text: 'What changed?' }])}, 'completed'),
      (${replyId}, ${row.workspace_id}, ${conversationId}, 'assistant', ${sql.json([{ type: 'text', text: 'Costs went up.' }])}, 'completed')`
    const feedback = () =>
      sql`select rating, comment, reason, share_conversation from ai_message_feedback
        where message_id = ${replyId}`

    await page.goto(`/app/${slug}/chat/${conversationId}`)
    const messages = page.getByRole('list', { name: 'Messages' }).getByRole('listitem')
    await expect(messages.nth(0)).toContainText('What changed?')
    await expect(messages.nth(1)).toContainText('Costs went up.')
    const reply = page
      .getByRole('list', { name: 'Messages' })
      .getByRole('listitem', { name: 'Assistant' })
    await expect(reply).toContainText('Costs went up.')
    // 等待水合：输入区在水合前整体禁用（HydratedControls）
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 30_000 })
    const group = reply.getByRole('group', { name: 'Rate this reply' })
    const up = group.getByRole('button', { name: 'Helpful', exact: true })
    const down = group.getByRole('button', { name: 'Not helpful', exact: true })

    // 点赞后再次点击即撤销
    await up.click()
    await expect(up).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await feedback()).map((r) => r.rating)).toEqual(['up'])
    await up.click()
    await expect(up).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await feedback()).length).toBe(0)

    // 点踩展开文字反馈；提交后收起，可再次修改
    await down.click()
    await expect(down).toHaveAttribute('aria-expanded', 'true')
    const form = reply.getByRole('form', { name: 'What could be better?' })
    await form.getByLabel('Tell us more (optional)').fill('Missing the staffing costs')
    await form.getByRole('button', { name: 'Send feedback' }).click()
    await expect(form).toHaveCount(0)
    await expect(reply.getByRole('status')).toHaveText('Thanks for your feedback.')
    await expect
      .poll(async () => (await feedback()).map((r) => [r.rating, r.comment]))
      .toEqual([['down', 'Missing the staffing costs']])
    await reply.getByRole('button', { name: 'Edit feedback' }).click()
    await expect(reply.getByLabel('Tell us more (optional)')).toHaveValue(
      'Missing the staffing costs',
    )
    await reply.getByLabel('Tell us more (optional)').fill('Missing staffing and tooling costs')
    // 画板的四个原因单选；选中后随反馈一起保存
    const reasons = reply.getByRole('group', { name: 'What could be better?' })
    await expect(reasons.getByRole('button')).toHaveText([
      'Inaccurate',
      'Incomplete',
      'No citation',
      'Too long',
    ])
    await reasons.getByRole('button', { name: 'No citation' }).click()
    await expect(reasons.getByRole('button', { name: 'No citation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // 共享对话勾选项默认不勾选，说明文字写明共享范围
    const share = reply.getByRole('checkbox', {
      name: /Share this reply and a few earlier messages/,
    })
    await expect(share).toHaveAttribute('aria-checked', 'false')
    await expect(share).toHaveAccessibleDescription(/this reply and up to 3 messages before it/)
    await share.click()
    await expect(share).toHaveAttribute('aria-checked', 'true')
    await reply.getByRole('button', { name: 'Send feedback' }).click()
    await expect
      .poll(async () => (await feedback()).map((r) => [r.comment, r.reason, r.share_conversation]))
      .toEqual([['Missing staffing and tooling costs', 'no_source', true]])

    // 刷新后评分与原因仍在
    // 服务端按已保存的评分渲染，无需等待水合
    await page.reload()
    const reloaded = page
      .getByRole('list', { name: 'Messages' })
      .getByRole('listitem', { name: 'Assistant' })
    await expect(
      reloaded.getByRole('button', { name: 'Not helpful', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 30_000 })
    await reloaded.getByRole('button', { name: 'Edit feedback' }).click()
    await expect(
      reloaded
        .getByRole('group', { name: 'What could be better?' })
        .getByRole('button', { name: 'No citation' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(reloaded.getByLabel('Tell us more (optional)')).toHaveValue(
      'Missing staffing and tooling costs',
    )
    await expect(
      reloaded.getByRole('checkbox', { name: /Share this reply and a few earlier messages/ }),
    ).toHaveAttribute('aria-checked', 'true')

    // 后台反馈列表：显示原因，可按原因筛选
    await sql`update "user" set role='admin' where id=${row.user_id}`
    await page.goto('/admin/feedback')
    await expect(page.getByRole('heading', { name: 'AI reply feedback' })).toBeVisible()
    const table = page.getByRole('table', { name: 'AI reply feedback' })
    const ours = table.locator('tbody tr', { hasText: replyId })
    await expect(ours).toContainText('No citation')
    await chooseOption(page.getByRole('combobox', { name: 'Reason', exact: true }), 'Too long')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page).toHaveURL(/reason=too_long/)
    await expect(ours).toHaveCount(0)
    await chooseOption(page.getByRole('combobox', { name: 'Reason', exact: true }), 'No citation')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page).toHaveURL(/reason=no_source/)
    await expect(ours).toContainText('No citation')
    await expect(table.locator('tbody tr', { hasNotText: 'No citation' })).toHaveCount(0)

    // 已共享的条目：可查看对话片段（被评回复与之前的提问），查看写入审计
    await expect(ours).toContainText('Shared')
    await ours.getByRole('button', { name: 'View conversation' }).click()
    const dialog = page.getByRole('dialog', { name: 'Shared conversation' })
    await expect(dialog).toContainText('What changed?')
    await expect(dialog).toContainText('Costs went up.')
    await expect(dialog).toContainText('Rated reply')
    await expect
      .poll(
        async () =>
          (
            await sql`select a.action from audit_log a join ai_message_feedback f
              on a.target_id = f.id::text where f.message_id = ${replyId}
              and a.action = 'ai.feedback.view_conversation'`
          ).length,
      )
      .toBe(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await chooseOption(page.getByRole('combobox', { name: 'Shared', exact: true }), 'Not shared')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page).toHaveURL(/shared=no/)
    await expect(ours).toHaveCount(0)
  } finally {
    await sql`delete from ai_message_feedback where message_id = ${replyId}`
    await sql`delete from ai_message where conversation_id = ${conversationId}`
    await sql`delete from ai_conversation where id = ${conversationId}`
    await sql.end()
  }
})
