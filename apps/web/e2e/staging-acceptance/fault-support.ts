import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { Pricing } from '@product-res/ai'
import { guidancePrefix } from './accounts.ts'
import { type FaultModelDefinition, faultScenarioId } from './fault-definitions.ts'
import type { FaultWorkspace } from './fault-readiness.ts'
import { evidence, expect, query, runId, sqlLiteral } from './support.ts'

// 固定终态后观察，不接受环境变量或本地快捷开关缩短。
const OBSERVATION_MS = 60_000
const TEXT_PROMPT =
  'Write a detailed description of a red square on a white background. Use at least 400 words and start immediately.'
const terminal = (status: string) =>
  ['failed', 'succeeded', 'canceled', 'completed', 'aborted'].includes(status)
function must(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`${guidancePrefix}故障核验：${message}；停止新提交，请用同一 run ID 核验原资源`)
}

type Ledger = { id: string; type: string; delta: number }
type Proof = {
  mode: string
  policyVersion: number
  injected: boolean
  realProviderCalled: boolean
  submitAttempts?: number
  pollCount?: number
  realRequestId?: string | null
  injectedAt: string | null
  callbackStoredAt?: string | null
  callbackCheckedAt?: string | null
  cancellation?: { status: string | null; providerStatus: string | null } | null
  phase?: string
  upstreamCalls?: number
  outputTokens?: number | null
}
type Resource = {
  id: string
  status: string
  modelKey: string
  credits: number
  pricing: Pricing
  holdId: string
  holdStatus: string
  held: number
  captured: number
  debited: number
  debt: number
  absorbed: number
  proof: Proof | null
  ledger: Ledger[]
  fileIds?: string[]
  visibleFileIds?: string[]
  outputFileIds?: string[]
  outputCount?: number
  notificationIds?: string[]
  providerJobId?: string | null
  callbackPresent?: boolean
  deadlineAt?: string
  finishedAt?: string
  errorCode?: string | null
  hasOutput?: boolean
  charCount?: number
  inputTokens?: number | null
  outputTokens?: number | null
  checkpointInputTokens?: number | null
  checkpointOutputTokens?: number | null
}
type Snapshot = Record<string, unknown> & {
  resources: Resource[]
  messageCount?: number
  userCount?: number
  ledgerTotal: number
  activeRemaining: number
  held: number
  debt: number
}

function reconciliationSql(workspaceId: string) {
  const id = sqlLiteral(workspaceId)
  // active 的已过期待 Cron grant 仍在账本中，不能在对账时按过期时间排除。
  return `(select coalesce(sum(delta),0)::float8 from credit_ledger where workspace_id=${id}) as "ledgerTotal",
    (select coalesce(sum(remaining),0)::float8 from credit_grant where workspace_id=${id} and status='active') as "activeRemaining",
    (select coalesce(sum(amount),0)::float8 from credit_hold where workspace_id=${id} and status='held') as held,
    (select coalesce(sum(amount),0)::float8 from credit_debt where workspace_id=${id}) as debt`
}
const holdSql = `h.id as "holdId", h.status as "holdStatus", h.amount as held,
  h.captured_amount as captured, h.overage_debited as debited,
  h.overage_debt as debt, h.overage_absorbed as absorbed`
function ledgerSql(workspaceId: string, refType: string, id: string) {
  return `coalesce((select json_agg(json_build_object('id',l.id,'type',l.type,'delta',l.delta) order by l.id)
    from credit_ledger l where l.workspace_id=${sqlLiteral(workspaceId)} and l.ref_type=${sqlLiteral(refType)} and l.ref_id=${id}::text),'[]'::json) as ledger`
}
function proofSql(root: string, media: boolean) {
  // 只投影固定字段，不读取未知 proof/input/正文，以免异常时泄露内容。
  return `case when ${root} is null then null else json_build_object(
    'mode',${root}->>'mode','policyVersion',(${root}->>'policyVersion')::int,
    'injected',(${root}->>'injected')::boolean,'realProviderCalled',(${root}->>'realProviderCalled')::boolean,
    'injectedAt',${root}->>'injectedAt',${
      media
        ? `
    'submitAttempts',(${root}->>'submitAttempts')::int,'pollCount',(${root}->>'pollCount')::int,
    'realRequestId',${root}->>'realRequestId','callbackStoredAt',${root}->>'callbackStoredAt',
    'callbackCheckedAt',${root}->>'callbackCheckedAt',
    'cancellation',case when ${root}->'cancellation' is null then null else json_build_object(
      'status',${root}->'cancellation'->>'status','providerStatus',${root}->'cancellation'->>'providerStatus') end`
        : `
    'phase',${root}->>'phase','upstreamCalls',(${root}->>'upstreamCalls')::int,
    'outputTokens',(${root}->>'outputTokens')::int`
    }) end as proof`
}
function identity(model: FaultModelDefinition) {
  return createHash('sha256')
    .update(`${runId}:${faultScenarioId(model)}`)
    .digest('hex')
    .slice(0, 20)
}
async function mediaSnapshot(workspace: FaultWorkspace, taskId: string) {
  const id = sqlLiteral(workspace.workspaceId)
  const [snapshot] = await query<Snapshot>(`select ${reconciliationSql(workspace.workspaceId)},
    coalesce((select json_agg(r) from (select t.id,t.status,t.model_key as "modelKey",t.pricing,
      t.credits_charged as credits,t.provider_job_id as "providerJobId",
      t.callback_payload is not null as "callbackPresent",t.deadline_at as "deadlineAt",
      t.finished_at as "finishedAt",t.error_code as "errorCode",${holdSql},
      ${proofSql("(t.input->'acceptanceFaultProof')", true)},
      coalesce((select json_agg(f.id order by f.id) from file f where f.source_task_id=t.id and f.workspace_id=t.workspace_id),'[]'::json) as "fileIds",
      coalesce((select json_agg(f.id order by f.id) from file f where f.source_task_id=t.id and f.workspace_id=t.workspace_id and f.deleted_at is null and f.status='ready'),'[]'::json) as "visibleFileIds",
      coalesce(jsonb_array_length(t.output->'files'),0) as "outputCount",
      coalesce((select json_agg(f->>'id' order by f->>'id') from jsonb_array_elements(
        coalesce(t.output->'files','[]'::jsonb)) f),'[]'::json) as "outputFileIds",
      coalesce((select json_agg(n.id order by n.id) from notification n where n.workspace_id=t.workspace_id and n.user_id=t.user_id
        and n.link=${sqlLiteral(`/app/${encodeURIComponent(workspace.slug)}/tasks/`)}||t.id::text),'[]'::json) as "notificationIds",
      ${ledgerSql(workspace.workspaceId, 'ai_task', 't.id')}
      from ai_task t left join credit_hold h on h.id=t.hold_id and h.workspace_id=t.workspace_id
      where t.workspace_id=${id} and t.user_id=${sqlLiteral(workspace.userId)} and t.id=${sqlLiteral(taskId)}) r),'[]'::json) as resources`)
  must(snapshot, '任务快照缺失')
  return snapshot
}
function checkReconciliation(snapshot: Snapshot) {
  must(
    snapshot.ledgerTotal === snapshot.activeRemaining + snapshot.held - snapshot.debt,
    '同快照积分对账失败',
  )
  return {
    ledgerTotal: snapshot.ledgerTotal,
    activeRemaining: snapshot.activeRemaining,
    held: snapshot.held,
    debt: snapshot.debt,
    difference: 0,
    consistent: true,
  }
}
function resource(snapshot: Snapshot, model: FaultModelDefinition) {
  must(snapshot.resources.length === 1, '缺失或重复业务资源')
  const row = snapshot.resources[0]
  must(row && row.modelKey === model.key && row.holdId, '模型或预扣不匹配')
  must(
    row.proof?.mode === model.mode &&
      row.proof.policyVersion === 1 &&
      row.proof.injected === true &&
      row.proof.injectedAt,
    `资源 ${row.id} 缺少实际注入证明`,
  )
  expect(row.pricing, '定价快照不匹配').toEqual(model.pricing)
  must(row.debited === 0 && row.debt === 0 && row.absorbed === 0, '不允许额外补扣、欠费或吸收')
  return row
}
function checkCharge(row: Resource, charge: number) {
  must(row.credits === charge && row.captured === charge, `资源 ${row.id} 精确费用不匹配`)
  must(row.holdStatus === (charge > 0 ? 'captured' : 'released'), `资源 ${row.id} hold 状态不匹配`)
  must(
    row.ledger.filter((entry) => entry.type === 'consume').length === (charge > 0 ? 1 : 0),
    '消费次数不匹配',
  )
  must(row.ledger.reduce((sum, entry) => sum + entry.delta, 0) === -charge, '资源账本数额不匹配')
  must(charge <= row.held, '估算费用超过预扣')
}
async function observe(
  read: () => Promise<Snapshot>,
  first: Snapshot,
  model: FaultModelDefinition,
) {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS))
  const second = await read()
  const row = resource(second, model)
  // 只比较同一资源的安全字段；新场景在观察结束前不会启动。
  must(
    JSON.stringify(second.resources) === JSON.stringify(first.resources),
    `资源 ${row.id} 终态后新增输出、通知、证明或结算`,
  )
  must(
    second.messageCount === first.messageCount && second.userCount === first.userCount,
    '终态后新增消息',
  )
  return {
    observedMs: Date.now() - started,
    lateReplayStatus: 'observed-only',
    reconciliation: checkReconciliation(second),
  }
}

export async function runMediaFaultScenario(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
) {
  const marker = `A red square on a white background. Acceptance ${identity(model)}.`
  const find = () =>
    query<{ id: string; status: string }>(`select id,status from ai_task
    where workspace_id=${sqlLiteral(workspace.workspaceId)} and user_id=${sqlLiteral(workspace.userId)}
    and model_key=${sqlLiteral(model.key)} and input->'params'->>'prompt'=${sqlLiteral(marker)} order by id`)
  let existing = await find()
  must(existing.length <= 1, '同一 run/scenario 存在重复媒体任务')
  let reused = existing.length === 1
  let taskId = existing[0]?.id
  if (taskId) must(terminal(existing[0]?.status ?? ''), `已有任务 ${taskId} 非终态`)
  else {
    const response = await page.request
      .post('/api/ai/tasks', {
        timeout: 120_000,
        data: {
          workspaceId: workspace.workspaceId,
          modelKey: model.key,
          params: { ...model.params, prompt: marker },
        },
      })
      .catch(() => null)
    if (!response) {
      existing = await find()
      must(existing.length === 1 && existing[0], '提交结果不确定且无法唯一定位原任务')
      taskId = existing[0].id
      reused = true
    } else {
      must(response.status() === 202, '媒体提交未被确认受理')
      const body = await response.json().catch(() => null)
      must(
        typeof body?.taskId === 'string' && /^[0-9a-f-]{36}$/.test(body.taskId),
        '媒体提交未返回有效 task ID',
      )
      taskId = body.taskId as string
    }
    await expect
      .poll(async () => (await mediaSnapshot(workspace, taskId as string)).resources[0]?.status, {
        timeout: 21 * 60_000,
        intervals: [2_000, 5_000, 10_000],
      })
      .toMatch(/^(succeeded|failed|canceled)$/)
  }
  must(taskId, '媒体 task ID 缺失')
  if (
    !reused &&
    ['fal-submit-response-lost', 'fal-provider-error', 'fal-timeout'].includes(model.mode)
  ) {
    // 终态事务先提交；runner 随后的外部取消证明允许有限只读等待。
    await expect
      .poll(
        async () => !!(await mediaSnapshot(workspace, taskId)).resources[0]?.proof?.cancellation,
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true)
  }
  const unique = await find()
  must(unique.length === 1 && unique[0]?.id === taskId, '提交后存在重复或不匹配任务')
  const read = () => mediaSnapshot(workspace, taskId)
  const snapshot = await read()
  const row = resource(snapshot, model)
  const success = ['fal-callback-lost', 'fal-callback-early'].includes(model.mode)
  must(row.status === (success ? 'succeeded' : 'failed'), `任务 ${taskId} 终态不匹配`)
  const workers = model.provider === 'workers-ai'
  must(
    row.proof?.realProviderCalled === !workers && row.proof.submitAttempts === (workers ? 0 : 1),
    'Provider 调用次数证明不匹配',
  )
  if (!workers)
    must(
      row.proof?.realRequestId && /^[A-Za-z0-9_-]{1,160}$/.test(row.proof.realRequestId),
      `任务 ${taskId} 缺少安全真实 request ID`,
    )
  if (model.mode === 'fal-submit-response-lost')
    must(row.providerJobId === null, '响应丢失不应补入业务 job ID')
  if (['fal-submit-response-lost', 'fal-provider-error', 'fal-timeout'].includes(model.mode))
    must(
      ['cancellation-requested', 'already-terminal'].includes(
        row.proof?.cancellation?.status ?? '',
      ),
      `任务 ${taskId} 外部取消未确认`,
    )
  if (model.mode === 'fal-callback-early') {
    const stored = Date.parse(row.proof?.callbackStoredAt ?? '')
    const checked = Date.parse(row.proof?.callbackCheckedAt ?? '')
    must(
      row.callbackPresent &&
        Number.isFinite(stored) &&
        Number.isFinite(checked) &&
        stored <= checked &&
        row.proof?.pollCount === 0,
      '未观察到真实回调先落库再检查',
    )
  } else if (!workers)
    must(row.callbackPresent === false && !row.proof?.callbackStoredAt, '无回调场景出现回调')
  if (model.mode === 'fal-callback-lost')
    must((row.proof?.pollCount ?? 0) > 0, '回调丢失没有真实轮询证明')
  if (model.mode.endsWith('timeout'))
    must(
      Number.isFinite(Date.parse(row.finishedAt ?? '')) &&
        Date.parse(row.finishedAt ?? '') >= Date.parse(row.deadlineAt ?? ''),
      '超时未实际跨过 deadline',
    )
  const price = model.pricing.mode === 'per_call' ? model.pricing.credits : 0
  must(row.held === price, '媒体原预扣不匹配定价')
  checkCharge(row, success ? price : 0)
  must(
    row.fileIds?.length === (success ? 1 : 0) &&
      row.visibleFileIds?.length === (success ? 1 : 0) &&
      row.outputCount === (success ? 1 : 0),
    '媒体产出或文件数不匹配',
  )
  must(row.notificationIds?.length === 1, '媒体终态通知不唯一')
  expect(row.outputFileIds, '任务输出必须引用本任务可用文件').toEqual(row.visibleFileIds)
  const reconciliation = checkReconciliation(snapshot)
  const observation = await observe(read, snapshot, model)
  const result = {
    resourceId: taskId,
    reused,
    version: workspace.version,
    mode: model.mode,
    ...row,
    releasedCredits: row.held - row.captured,
    reconciliation,
    observation,
  }
  await evidence(`fault-${faultScenarioId(model)}`, result)
  return result
}

async function textSnapshot(workspace: FaultWorkspace, conversationId: string) {
  const cid = sqlLiteral(conversationId)
  const [snapshot] = await query<Snapshot>(`select ${reconciliationSql(workspace.workspaceId)},
    (select count(*)::int from ai_message where conversation_id=${cid} and workspace_id=${sqlLiteral(workspace.workspaceId)}) as "messageCount",
    (select count(*)::int from ai_message where conversation_id=${cid} and workspace_id=${sqlLiteral(workspace.workspaceId)} and role='user') as "userCount",
    coalesce((select json_agg(r) from (select m.id,m.status,m.model_key as "modelKey",m.pricing,m.credits,
      ${holdSql},m.input_tokens as "inputTokens",m.output_tokens as "outputTokens",
      (m.usage_checkpoint->>'inputTokens')::int as "checkpointInputTokens",(m.usage_checkpoint->>'outputTokens')::int as "checkpointOutputTokens",
      ${proofSql("(m.usage_checkpoint->'acceptanceFaultProof')", false)},
      coalesce((select sum(length(p->>'text'))::int from jsonb_array_elements(m.parts) p where p->>'type'='text'),0) as "charCount",
      exists(select 1 from jsonb_array_elements(m.parts) p where p->>'type'='text' and length(p->>'text')>0) as "hasOutput",
      ${ledgerSql(workspace.workspaceId, 'ai_message', 'm.id')}
      from ai_message m left join credit_hold h on h.id=m.hold_id and h.workspace_id=m.workspace_id
      where m.workspace_id=${sqlLiteral(workspace.workspaceId)} and m.conversation_id=${cid} and m.role='assistant') r),'[]'::json) as resources`)
  must(snapshot, '文本快照缺失')
  return snapshot
}

export async function runTextFaultScenario(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
) {
  const title = `Fault ${identity(model)} ${faultScenarioId(model)}`
  const conversations = await query<{ id: string }>(`select id from ai_conversation where
    workspace_id=${sqlLiteral(workspace.workspaceId)} and user_id=${sqlLiteral(workspace.userId)}
    and title=${sqlLiteral(title)} order by id`)
  must(conversations.length <= 1, '同一 run/scenario 存在重复对话')
  let conversationId = conversations[0]?.id
  if (!conversationId) {
    await page.goto(`/app/${workspace.slug}/chat`)
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
    conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    await page.getByRole('link', { name: 'All chats', exact: true }).click()
    const row = page
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href$="/chat/${conversationId}"]`) })
    await row.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByLabel('Conversation title', { exact: true }).fill(title)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('listitem', { name: title, exact: true })).toBeVisible()
  }
  const cid = conversationId
  const read = () => textSnapshot(workspace, cid)
  const existing = await read()
  must(existing.resources.length <= 1, '已有对话存在重复 assistant')
  const reused = existing.resources.length === 1
  if (reused)
    must(
      existing.resources[0]?.status === 'failed',
      `已有消息 ${existing.resources[0]?.id} 非预期终态`,
    )
  else {
    must(existing.messageCount === 0, '已有 user 消息但无 assistant，禁止重新发送')
    await page.goto(`/app/${workspace.slug}/chat/${cid}`)
    await expect
      .poll(
        async () => {
          await page.reload()
          return page
            .getByLabel('Model', { exact: true })
            .locator('option[value]')
            .allTextContents()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toContain(model.key)
    await page.getByLabel('Model', { exact: true }).selectOption({ label: model.key })
    await page.getByLabel('Message', { exact: true }).fill(TEXT_PROMPT)
    // 仅一次点击；响应或流错误后只读原对话，不重新发送。
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(async () => (await read()).resources[0]?.status, {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
      })
      .toMatch(/^(failed|completed|aborted)$/)
  }
  const snapshot = await read()
  const row = resource(snapshot, model)
  must(
    snapshot.messageCount === 2 && snapshot.userCount === 1 && row.status === 'failed',
    '文本消息数或 failed 终态不匹配',
  )
  const mid = model.mode === 'chat-mid-stream'
  must(
    row.proof?.phase === (mid ? 'mid-stream' : 'before-stream') &&
      row.proof.realProviderCalled === mid &&
      row.proof.upstreamCalls === (mid ? 1 : 0),
    '文本注入位置或上游调用证明不匹配',
  )
  must(
    row.hasOutput === mid && (mid ? (row.charCount ?? 0) > 0 : row.charCount === 0),
    '文本部分输出不匹配',
  )
  must(
    row.checkpointInputTokens !== null &&
      (row.checkpointInputTokens ?? 0) > 0 &&
      (mid ? (row.checkpointOutputTokens ?? 0) >= 200 : row.checkpointOutputTokens === 0),
    '文本检查点用量不匹配',
  )
  if (mid) must((row.proof?.outputTokens ?? 0) >= 200, '文本未达到实际注入阈值')
  const expectedInputTokens = [...TEXT_PROMPT].length + 8
  must(row.checkpointInputTokens === expectedInputTokens, '文本输入估算与原消息不匹配')
  if (mid)
    must(
      row.inputTokens === expectedInputTokens && row.outputTokens === row.charCount,
      '文本部分输出估算不匹配',
    )
  let charge: number
  if (model.pricing.mode === 'per_call') {
    charge = mid ? model.pricing.credits : 0
    must(row.held === model.pricing.credits, '文本按次预扣不匹配')
    if (!mid)
      must(row.inputTokens === null && row.outputTokens === null, '无输出按次应清空收费 token')
  } else if (model.pricing.mode === 'token') {
    must(
      row.held ===
        Math.max(
          Math.ceil(
            (expectedInputTokens * model.pricing.inputPer1k + 1024 * model.pricing.outputPer1k) /
              1000,
          ),
          model.pricing.minCharge ?? 1,
        ),
      '文本 token 原预扣不匹配',
    )
    must(
      row.inputTokens === row.checkpointInputTokens &&
        row.outputTokens !== null &&
        (mid ? (row.outputTokens ?? 0) >= 200 : row.outputTokens === 0),
      '文本估算用量不匹配',
    )
    charge = Math.min(
      row.held,
      Math.max(
        Math.ceil(
          ((row.inputTokens ?? 0) * model.pricing.inputPer1k +
            (row.outputTokens ?? 0) * model.pricing.outputPer1k) /
            1000,
        ),
        model.pricing.minCharge ?? 1,
      ),
    )
  } else throw new Error('Unsupported fault text pricing')
  checkCharge(row, charge)
  const reconciliation = checkReconciliation(snapshot)
  const observation = await observe(read, snapshot, model)
  const result = {
    resourceId: row.id,
    conversationId: cid,
    reused,
    version: workspace.version,
    mode: model.mode,
    ...row,
    releasedCredits: row.held - row.captured,
    reconciliation,
    observation,
  }
  await evidence(`fault-${faultScenarioId(model)}`, result)
  return result
}
