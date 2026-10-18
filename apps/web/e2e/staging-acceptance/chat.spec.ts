import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { deepseekCall, deepseekToken, verifyAcceptanceModel } from './models.ts'
import {
  evidence,
  expect,
  login,
  query,
  readEvidence,
  reconcile,
  requireEnv,
  runId,
  sqlLiteral,
  test,
} from './support.ts'

type Scenario = 'normal' | 'stop' | 'page-close'
// runId 可长达 64 字符；保留稳定摘要，避免超过对话标题 80 字符限制。
const titleRun =
  runId.length <= 40 ? runId : createHash('sha256').update(runId).digest('hex').slice(0, 20)
type Conversation = Record<string, unknown> & { id: string }
type Message = Record<string, unknown> & {
  id: string
  status: string
  created_at: string
  updated_at: string
  model_key: string
  input_tokens: number | null
  output_tokens: number | null
  credits: number | null
  text: string
  pricing: {
    mode: string
    credits?: number
    inputPer1k?: number
    outputPer1k?: number
    minCharge?: number
  }
  usage_checkpoint: { inputTokens: number; outputTokens: number } | null
  hold_id: string
  hold_status: string
  amount: number
  captured_amount: number
  overage_absorbed: number
  overage_debited: number
  overage_debt: number
}

async function messages(conversationId: string) {
  return query<Message>(`select m.id, m.status, m.created_at, m.updated_at, m.model_key, m.input_tokens, m.output_tokens,
    m.credits, m.pricing, m.usage_checkpoint, m.hold_id,
    coalesce((select string_agg(p->>'text', '' order by n)
      from jsonb_array_elements(m.parts) with ordinality as part(p,n)
      where p->>'type' = 'text'), '') as text,
    h.status as hold_status, h.amount, h.captured_amount,
    h.overage_absorbed, h.overage_debited, h.overage_debt
    from ai_message m left join credit_hold h on h.id = m.hold_id
    where m.conversation_id = ${sqlLiteral(conversationId)} and m.role = 'assistant'
    order by m.created_at, m.id`)
}

async function conversation(page: Page, slug: string, workspaceId: string, title: string) {
  const email = process.env.STAGING_USER_EMAIL ?? ''
  const rows = await query<Conversation>(`select c.id from ai_conversation c
    join "user" u on u.id = c.user_id where c.workspace_id = ${sqlLiteral(workspaceId)}
    and u.email = ${sqlLiteral(email)} and c.title = ${sqlLiteral(title)}`)
  expect(
    rows.length,
    'Stable acceptance title must identify at most one conversation',
  ).toBeLessThanOrEqual(1)
  if (rows[0]) return { id: rows[0].id, reused: true }
  await page.goto(`/app/${slug}/chat`)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  // 先保存稳定名称再发送收费请求：失败重跑可从只读数据库找到原步骤。
  await page.getByRole('link', { name: 'All chats', exact: true }).click()
  const row = page.getByRole('listitem').filter({
    has: page.locator(`a[href$="/chat/${id}"]`),
  })
  await row.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByLabel('Conversation title', { exact: true }).fill(title)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('listitem', { name: title, exact: true })).toBeVisible()
  return { id, reused: false }
}

async function accounting(workspaceId: string, saved: Message, scenario: Scenario) {
  const ledgerOf = () =>
    query<Record<string, unknown> & { id: string; type: string; delta: number }>(
      `select id, type, delta from credit_ledger where workspace_id = ${sqlLiteral(workspaceId)}
        and ref_type = 'ai_message' and ref_id = ${sqlLiteral(saved.id)} order by created_at, id`,
    )
  // 停止可能早于首个输出：按 token 仍按最低费用结算；按次计费无输出时释放预扣、不扣费。
  if (scenario === 'stop' && saved.text === '' && saved.pricing.mode === 'per_call') {
    expect(saved.hold_status).toBe('released')
    expect(saved.credits).toBe(0)
    expect(saved.input_tokens).toBeNull()
    expect(saved.output_tokens).toBeNull()
    expect(saved.captured_amount + saved.overage_debited + saved.overage_debt).toBe(0)
    const ledger = await ledgerOf()
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0)
    expect(ledger.reduce((sum, entry) => sum + entry.delta, 0)).toBe(0)
    return { ledger, reconciliation: await reconcile(workspaceId) }
  }
  if (scenario !== 'stop') expect(saved.text.length, 'Reply must have output').toBeGreaterThan(0)
  expect(saved.input_tokens).not.toBeNull()
  expect(saved.output_tokens).not.toBeNull()
  expect(saved.credits).not.toBeNull()
  expect(saved.hold_status).toBe('captured')
  expect(saved.overage_debt).toBe(0)
  const pricing = saved.pricing
  const calculated =
    pricing.mode === 'per_call'
      ? (pricing.credits ?? 0)
      : Math.max(
          Math.ceil(
            ((saved.input_tokens ?? 0) * (pricing.inputPer1k ?? 0) +
              (saved.output_tokens ?? 0) * (pricing.outputPer1k ?? 0)) /
              1000,
          ),
          pricing.minCharge ?? 1,
        )
  const expected = scenario === 'stop' ? Math.min(calculated, saved.amount) : calculated
  expect(saved.captured_amount + saved.overage_absorbed + saved.overage_debited).toBe(expected)
  expect(saved.credits).toBe(saved.captured_amount + saved.overage_debited)
  if (scenario === 'stop') {
    expect(saved.overage_absorbed).toBe(0)
    expect(saved.overage_debited).toBe(0)
    expect(saved.credits).toBeLessThanOrEqual(saved.amount)
  }
  const ledger = await ledgerOf()
  expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(1)
  expect(ledger.reduce((sum, entry) => sum + entry.delta, 0)).toBe(-(saved.credits ?? 0))
  return { ledger, reconciliation: await reconcile(workspaceId) }
}

for (const [billing, model] of [
  ['token', deepseekToken],
  ['call', deepseekCall],
] as const) {
  for (const scenario of ['normal', 'stop', 'page-close'] as const) {
    test(`Chat 5.1 ${billing}: ${scenario}`, async ({ page, context }) => {
      test.setTimeout(180_000)
      requireEnv(['NEON_READONLY_URL'])
      await login(page, 'user')
      await verifyAcceptanceModel(model)
      const sessionResponse = await page.request.get('/api/auth/get-session')
      expect(sessionResponse.status()).toBe(200)
      const session = (await sessionResponse.json()) as { user: { id: string; role?: string } }
      expect(session.user.role?.split(',').map((role) => role.trim()) ?? []).not.toContain('admin')
      const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
      const [workspace] = await query<Record<string, unknown> & { id: string }>(
        `select o.id from organization o join member m on m.organization_id=o.id
          where o.slug = ${sqlLiteral(slug)} and m.user_id=${sqlLiteral(session.user.id)} and o.deleted_at is null`,
      )
      expect(workspace, 'Authenticated workspace must exist').toBeDefined()
      if (!workspace) throw new Error('Authenticated workspace missing')
      const title = `Acceptance ${titleRun} ${billing} ${scenario}`
      const step = await conversation(page, slug, workspace.id, title)
      let viewer = page
      await page.goto(`/app/${slug}/chat/${step.id}`)
      const existing = await messages(step.id)
      expect(
        existing.length,
        'Never create a second paid request for the same acceptance step',
      ).toBeLessThanOrEqual(1)
      let reused = existing.length > 0
      let closedAt: number | undefined
      let recordedCloseAt: number | undefined
      const closeMarkerName = `chat-${billing}-page-close-action`
      if (scenario === 'page-close' && reused) {
        const marker = await readEvidence<{ messageId: string; status: string; closedAt: number }>(
          closeMarkerName,
        )
        test.skip(
          marker?.messageId !== existing[0]?.id || marker?.status !== 'closed-during-generation',
          'Existing reply lacks page-close action evidence; review manually without another paid request',
        )
        recordedCloseAt = marker?.closedAt
      }
      if (!existing.length) {
        const [count] = await query<Record<string, unknown> & { count: number }>(
          `select count(*)::int as count from ai_message where conversation_id = ${sqlLiteral(step.id)}`,
        )
        // 请求结果不明确时不自动重发，交给操作者核对已有会话。
        expect(
          count?.count,
          'Existing messages without assistant require manual review; no paid retry',
        ).toBe(0)
        await expect
          .poll(
            async () => {
              await page.reload()
              return page
                .getByLabel('Model', { exact: true })
                .locator(`option[value]`)
                .allTextContents()
            },
            { timeout: 90_000, intervals: [2_000, 5_000] },
          )
          .toContain(model.key)
        await page.getByLabel('Model', { exact: true }).selectOption({ label: model.key })
        const prompt = `acceptance-scenario: ${scenario}\n${
          scenario === 'normal'
            ? 'Reply with one short sentence.'
            : 'Count from 1 to 100, writing each number in words on its own line. Start immediately and do not add an introduction.'
        }`
        await page.getByLabel('Message', { exact: true }).fill(prompt)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        const started = page.getByRole('listitem', { name: 'Assistant', exact: true })
        if (scenario === 'normal') await expect(started.locator('p')).toHaveText(/\S/)
        else {
          // staging 上游把推理与正文缓冲后集中下发：首个可见文本到达时生成已经结束、Stop 已消失。
          // 因此在流 start 事件渲染出回复（服务端已有 streaming 消息）后立即停止或关页，
          // 不等待首个可见输出；无输出与有部分输出两种停止结算都由 accounting 校验。
          await expect(started, 'Assistant reply must start streaming').toHaveCount(1)
          await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
          if (scenario === 'stop')
            await page.getByRole('button', { name: 'Stop', exact: true }).click()
          else {
            const [streaming] = await messages(step.id)
            expect(streaming?.status).toBe('streaming')
            await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
            await page.close()
            closedAt = Date.now()
            recordedCloseAt = closedAt
            await evidence(closeMarkerName, {
              messageId: streaming?.id,
              status: 'closed-during-generation',
              closedAt,
            })
            viewer = await context.newPage()
          }
        }
        reused = false
      } else if (existing[0]?.status === 'streaming' && scenario === 'stop') {
        // 跨进程重跑可能仍在生成；停止原消息，绝不创建新消息。
        const response = await page.request.post(`/api/ai/chat/${existing[0].id}/stop`, {
          data: { slug },
        })
        expect(response.ok()).toBe(true)
      }
      const expectedStatus = scenario === 'stop' ? 'aborted' : 'completed'
      await expect
        .poll(async () => (await messages(step.id))[0]?.status, {
          timeout: closedAt ? 25_000 : 90_000,
          intervals: [500, 1_000, 2_000],
        })
        .toBe(expectedStatus)
      if (closedAt) expect(Date.now() - closedAt).toBeLessThan(30_000)
      const [saved] = await messages(step.id)
      if (!saved) throw new Error('Acceptance assistant message missing')
      const tailCompletionMs =
        recordedCloseAt === undefined ? undefined : Date.parse(saved.updated_at) - recordedCloseAt
      if (scenario === 'page-close') {
        expect(tailCompletionMs).toBeGreaterThanOrEqual(0)
        expect(tailCompletionMs).toBeLessThan(30_000)
      }
      expect(saved.model_key).toBe(model.key)
      expect(saved.pricing.mode).toBe(billing === 'call' ? 'per_call' : 'token')
      await viewer.goto(`/app/${slug}/chat/${step.id}`)
      const reply = viewer.getByRole('listitem', { name: 'Assistant', exact: true })
      await expect(reply).toContainText(saved.text)
      if (scenario === 'stop') await expect(reply).toContainText('Stopped')
      else await expect(reply).not.toContainText('Incomplete')
      const result = await accounting(workspace.id, saved, scenario)
      await evidence(`chat-${billing}-${scenario}`, {
        status: saved.status,
        modelKey: model.key,
        workspaceId: workspace.id,
        conversationId: step.id,
        messageId: saved.id,
        generationStartedAt: saved.created_at,
        holdId: saved.hold_id,
        reused,
        textLength: saved.text.length,
        tailCompletionMs,
        inputTokens: saved.input_tokens,
        outputTokens: saved.output_tokens,
        checkpointInputTokens: saved.usage_checkpoint?.inputTokens ?? null,
        checkpointOutputTokens: saved.usage_checkpoint?.outputTokens ?? null,
        credits: saved.credits,
        holdAmount: saved.amount,
        capturedAmount: saved.captured_amount,
        ledger: result.ledger,
        reconciliation: result.reconciliation,
        gatewayComparisonStatus: 'pending-log-read-token',
      })
    })
  }
}
