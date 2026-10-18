import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { MediaTask } from '../../src/features/ai-media/tasks-client.ts'
import { evidence, expect, query, reconcile, runId, sqlLiteral } from './support.ts'

export type MediaModel = {
  key: string
  params: Record<string, unknown>
  pricing: { mode: string; credits?: number }
}

export async function mediaWorkspace(page: Page) {
  await page.goto('/app')
  await expect(page).toHaveURL(/\/app\/[^/]+\/?$/)
  const slug = new URL(page.url()).pathname.split('/')[2]
  const sessionResponse = await page.request.get('/api/auth/get-session')
  expect(sessionResponse.status()).toBe(200)
  const session = (await sessionResponse.json()) as { user: { id: string; role?: string } }
  expect(
    session.user.role?.split(',').map((role) => role.trim()) ?? [],
    '媒体验收需要普通用户账号',
  ).not.toContain('admin')
  const rows = await query<{ id: string }>(`
    select o.id from organization o join member m on m.organization_id = o.id
    where o.slug = ${sqlLiteral(slug ?? '')}
      and m.user_id = ${sqlLiteral(session.user.id)} and o.deleted_at is null
  `)
  expect(rows).toHaveLength(1)
  return { workspaceId: rows[0]?.id as string, userId: session.user.id }
}

export async function readTask(page: Page, workspaceId: string, taskId: string) {
  const response = await page.request.get(
    `/api/ai/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
  )
  expect(response.status()).toBe(200)
  return ((await response.json()) as { task: MediaTask }).task
}

export async function reuseOrSubmit(
  page: Page,
  workspace: { workspaceId: string; userId: string },
  model: MediaModel,
  step: string,
) {
  // 固定标记落在已有业务输入中；响应丢失或证据未写完也能从只读库恢复，绝不盲重发。
  const identity = createHash('sha256').update(`${runId}:${step}`).digest('hex').slice(0, 20)
  const prompt = `A red square on a white background. Acceptance ${identity}.`
  const find = () =>
    query<{ id: string }>(`
      select id from ai_task
      where workspace_id = ${sqlLiteral(workspace.workspaceId)}
        and user_id = ${sqlLiteral(workspace.userId)}
        and model_key = ${sqlLiteral(model.key)}
        and input -> 'params' ->> 'prompt' = ${sqlLiteral(prompt)}
      order by id
    `)
  const existing = await find()
  expect(existing.length, '同一 run/step 不得存在重复生成任务').toBeLessThanOrEqual(1)
  if (existing[0]) return { taskId: existing[0].id, reused: true }

  const response = await page.request
    .post('/api/ai/tasks', {
      data: {
        workspaceId: workspace.workspaceId,
        modelKey: model.key,
        params: { ...model.params, prompt },
      },
    })
    .catch(() => null)
  if (!response) {
    const recovered = await find()
    expect(recovered, '提交结果不确定；重跑同一 run ID 恢复，禁止直接再次提交').toHaveLength(1)
    return { taskId: recovered[0]?.id as string, reused: true }
  }
  expect(response.status(), '提交失败时不自动重试；确认模型、权益及用户积分后重跑').toBe(202)
  const body = (await response.json()) as { taskId: string }
  expect(body.taskId).toMatch(/^[0-9a-f-]{36}$/)
  return { taskId: body.taskId, reused: false }
}

export async function awaitTerminal(page: Page, workspaceId: string, taskId: string) {
  let task = await readTask(page, workspaceId, taskId)
  await expect
    .poll(
      async () => {
        task = await readTask(page, workspaceId, taskId)
        return task.status
      },
      { timeout: 20 * 60_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toMatch(/^(succeeded|failed|canceled)$/)
  return task
}

// Workers AI 偶发把无害提示误判为 NSFW（上游 8007）；产品有意不重试以免绕过内容过滤。
// 仅凭任务接口返回的安全摘要识别，错误码与消息格式需同时匹配，其他失败一律不放行。
const WORKERS_UPSTREAM_8007 =
  /^Workers AI image generation failed \((?:[A-Za-z][A-Za-z0-9_]{0,63} )?8007\)$/

export function isWorkersUpstream8007(
  task: Pick<MediaTask, 'status' | 'errorCode' | 'errorMessage'>,
) {
  return (
    task.status === 'failed' &&
    task.errorCode === 'WORKERS_AI_GENERATION_FAILED' &&
    WORKERS_UPSTREAM_8007.test(task.errorMessage ?? '')
  )
}

export async function verifyMediaAccounting(
  workspaceId: string,
  taskId: string,
  expectedStatus: 'succeeded' | 'failed' | 'canceled',
  expectedPrice: number,
) {
  const rows = await query<{
    id: string
    status: string
    credits: number
    mode: string
    price: number
    holdId: string
    holdStatus: string
    held: number
    captured: number
    debited: number
    debt: number
    absorbed: number
  }>(`
    select t.id, t.status, t.credits_charged as credits,
      t.pricing ->> 'mode' as mode, (t.pricing ->> 'credits')::int as price,
      h.id as "holdId", h.status as "holdStatus", h.amount as held,
      h.captured_amount as captured, h.overage_debited as debited,
      h.overage_debt as debt, h.overage_absorbed as absorbed
    from ai_task t join credit_hold h on h.id = t.hold_id and h.workspace_id = t.workspace_id
    where t.workspace_id = ${sqlLiteral(workspaceId)} and t.id = ${sqlLiteral(taskId)}
  `)
  expect(rows).toHaveLength(1)
  const row = rows[0]
  if (!row) throw new Error('媒体任务结算记录缺失')
  expect(row.status).toBe(expectedStatus)
  expect(row.mode).toBe('per_call')
  expect(row.price).toBe(expectedPrice)
  expect(row.held).toBe(expectedPrice)
  const charge = expectedStatus === 'succeeded' ? expectedPrice : 0
  expect(row.credits).toBe(charge)
  expect(row.captured).toBe(charge)
  expect(row.holdStatus).toBe(expectedStatus === 'succeeded' ? 'captured' : 'released')
  expect(row.debited + row.debt + row.absorbed).toBe(0)
  const ledger = await query<{ id: string; type: string; delta: number }>(`
    select id, type, delta from credit_ledger
    where workspace_id = ${sqlLiteral(workspaceId)}
      and ref_type = 'ai_task' and ref_id = ${sqlLiteral(taskId)} order by id
  `)
  const consumption = ledger.filter((entry) => entry.type === 'consume')
  expect(consumption).toHaveLength(charge > 0 ? 1 : 0)
  expect(ledger.reduce((sum, entry) => sum + entry.delta, 0)).toBe(charge > 0 ? -charge : 0)

  const snapshot = await reconcile(workspaceId)
  return { row, ledger, snapshot }
}

export async function recordMedia(
  step: string,
  task: MediaTask,
  reused: boolean,
  accounting: Awaited<ReturnType<typeof verifyMediaAccounting>>,
) {
  await evidence(step, {
    taskId: task.id,
    workspaceId: task.workspaceId,
    userId: task.userId,
    status: task.status,
    modelKey: task.modelKey,
    creditsCharged: task.creditsCharged,
    fileIds: task.files.map((file) => file.id),
    reused,
    holdId: accounting.row.holdId,
    holdStatus: accounting.row.holdStatus,
    heldCredits: accounting.row.held,
    capturedCredits: accounting.row.captured,
    ledger: accounting.ledger,
    reconciliation: accounting.snapshot,
  })
}
