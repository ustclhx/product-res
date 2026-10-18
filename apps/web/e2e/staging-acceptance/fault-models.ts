import { isDeepStrictEqual } from 'node:util'
import type { Page } from '@playwright/test'
import { safeDiagnostic } from './diagnostic.ts'
import type { FaultModelDefinition } from './fault-definitions.ts'
import { createAcceptanceModel } from './models.ts'
import { expect, query, sqlLiteral } from './support.ts'

export type FaultCleanupStage = 'read' | 'configuration' | 'editor' | 'disable' | 'confirm'

export interface FaultCleanupResult {
  key: string
  id?: string
  status: 'disabled' | 'already-disabled' | 'failed'
  auditIds: string[]
  /** 实际尝试次数；失败时附最后一次的阶段与安全类别，不含页面或驱动原文。 */
  attempts?: number
  failure?: { stage: FaultCleanupStage; diagnostic: string }
}

type ModelRow = Record<string, unknown> & { id: string; enabled: boolean }
type CleanupEntry = { expected: FaultModelDefinition; id?: string }

export async function readFaultModel(model: FaultModelDefinition) {
  if (!process.env.NEON_READONLY_URL)
    throw new Error('Fault model checks require NEON_READONLY_URL')
  const rows = await query<ModelRow>(`select id, key, kind, provider, provider_model_id, pricing,
    min_plan_features, params_schema, enabled, sort from ai_model
    where key=${sqlLiteral(model.key)}`)
  if (rows.length > 1) throw new Error('Fault model key is not unique')
  return rows[0]
}

function verifyConfiguration(row: ModelRow, expected: FaultModelDefinition) {
  const { id: _id, enabled: _enabled, ...configuration } = row
  if (
    !isDeepStrictEqual(configuration, {
      key: expected.key,
      kind: expected.kind,
      provider: expected.provider,
      provider_model_id: expected.providerModelId,
      pricing: expected.pricing,
      min_plan_features: [],
      params_schema: expected.paramsSchema,
      sort: expected.sort,
    })
  )
    // 配置可能包含内容；错误只保留可核验的资源 ID。
    throw new Error(`Fault model configuration conflict (resource ${row.id})`)
}

export async function faultModelEditor(page: Page, model: FaultModelDefinition, id: string) {
  // 后台默认每页 50 项，按同一 sort/key 顺序定位，不能假定专用模型在首页。
  const [position] = await query<{ rank: number }>(`select rank from (
    select id, (row_number() over (order by sort asc, key asc)-1)::int as rank from ai_model
    ) positions where id=${sqlLiteral(id)}`)
  if (!position) throw new Error(`Fault model not found (resource ${id})`)
  await page.goto(`/admin/models?order=sort&offset=${Math.floor(position.rank / 50) * 50}`)
  const editor = page.getByRole('article', { name: `Model ${model.key}`, exact: true })
  await expect(editor).toBeVisible()
  return editor
}

async function disabledAudits(id: string) {
  return query<{ id: string }>(`select id from audit_log
    where action='ai.model_disabled' and target_id=${sqlLiteral(id)} order by id`)
}

// 单项停用的有界重试：每次先只读确认当前状态，已停用即不再点击，因此重复尝试是幂等的。
const DISABLE_ATTEMPTS = 3
const DISABLE_RETRY_DELAY_MS = 2_000
const UI_TIMEOUT_MS = 20_000

class CleanupStageError extends Error {
  constructor(
    readonly stage: FaultCleanupStage,
    readonly retryable: boolean,
    readonly origin?: unknown,
  ) {
    super(`Fault model cleanup failed at ${stage}`)
  }
}

async function stage<T>(name: FaultCleanupStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CleanupStageError) throw error
    throw new CleanupStageError(name, true, error)
  }
}

/**
 * 停用一个已登记模型，结果写入 result。配置或身份不匹配不可重试，也绝不覆盖；
 * 其余阶段（只读查询、页面接管、RPC、确认）失败时由调用方整体重试。
 */
async function disableEntry(
  page: Page,
  entry: CleanupEntry,
  result: FaultCleanupResult,
  baseline: { ids?: Set<string>; clicked: boolean },
) {
  const row = await stage('read', () => readFaultModel(entry.expected))
  if (!row) {
    // 创建在写库前被拒绝时没有遗留资源，无需制造一次停用审计。
    if (entry.id) throw new CleanupStageError('configuration', false)
    result.status = 'already-disabled'
    return
  }
  result.id = row.id
  try {
    verifyConfiguration(row, entry.expected)
  } catch (error) {
    throw new CleanupStageError('configuration', false, error)
  }
  if (entry.id && entry.id !== row.id) throw new CleanupStageError('configuration', false)
  // 基线只取首次读取：前一次尝试的点击可能已生效但未确认，新审计仍应计入本次停用。
  baseline.ids ??= new Set((await stage('read', () => disabledAudits(row.id))).map((a) => a.id))
  // 停用 RPC 与审计同事务；只读副本可能滞后，按有界轮询确认出现新的停用审计。
  const confirmed = async () => {
    const after = await disabledAudits(row.id)
    if (!after.some((audit) => !baseline.ids?.has(audit.id))) return false
    result.auditIds = after.map((audit) => audit.id)
    result.status = 'disabled'
    return true
  }
  const confirm = () =>
    stage('confirm', () => expect.poll(confirmed, { timeout: UI_TIMEOUT_MS }).toBe(true))
  if (!row.enabled) {
    if (baseline.clicked) return confirm()
    result.auditIds = [...baseline.ids]
    result.status = 'already-disabled'
    return
  }
  const editor = await stage('editor', async () => {
    const editor = await faultModelEditor(page, entry.expected, row.id)
    // SSR 表单在 React 接管前禁用；等接管完成再点，避免点击落空。
    await expect(editor).toHaveAttribute('aria-busy', 'false', { timeout: UI_TIMEOUT_MS })
    return editor
  })
  const status = editor.getByRole('status')
  await stage('disable', async () => {
    // 按钮名为 Disable 才代表此次提交 enabled=false；页面陈旧显示 Enable 时等待超时而不会误启用。
    const button = editor.getByRole('button', { name: 'Disable', exact: true })
    await expect(button).toBeEnabled({ timeout: UI_TIMEOUT_MS })
    baseline.clicked = true
    await button.click({ timeout: UI_TIMEOUT_MS })
    await expect(status).not.toHaveText('', { timeout: UI_TIMEOUT_MS })
    // 拒绝文案可能回显服务端信息，只按固定成功文案判定。
    if ((await status.textContent())?.trim() !== 'Saved.')
      throw new CleanupStageError('disable', true)
  })
  await stage('confirm', () =>
    expect
      .poll(async () => (await readFaultModel(entry.expected))?.enabled, {
        timeout: UI_TIMEOUT_MS,
      })
      .toBe(false),
  )
  await confirm()
}

async function cleanupEntries(page: Page, entries: CleanupEntry[]): Promise<FaultCleanupResult[]> {
  const results: FaultCleanupResult[] = []
  for (const entry of entries) {
    const result: FaultCleanupResult = {
      key: entry.expected.key,
      ...(entry.id ? { id: entry.id } : {}),
      status: 'failed',
      auditIds: [],
    }
    results.push(result)
    const baseline: { ids?: Set<string>; clicked: boolean } = { clicked: false }
    for (let attempt = 1; attempt <= DISABLE_ATTEMPTS; attempt++) {
      result.attempts = attempt
      try {
        await disableEntry(page, entry, result, baseline)
        delete result.failure
        break
      } catch (error) {
        // 单项失败不能跳过其他资源；只记录阶段与固定类别，原错误可能含选择器、URL 或页面文本。
        const failed =
          error instanceof CleanupStageError ? error : new CleanupStageError('read', true, error)
        const cause = failed.origin instanceof Error ? failed.origin.message : undefined
        result.status = 'failed'
        result.failure = { stage: failed.stage, diagnostic: safeDiagnostic(cause) }
        if (!failed.retryable) break
        if (attempt < DISABLE_ATTEMPTS)
          await new Promise((resolve) => setTimeout(resolve, DISABLE_RETRY_DELAY_MS * attempt))
      }
    }
  }
  return results
}

// 供本地负面用例在撤掉 UI 故障后停用其自有且完整匹配的遗留模型。
export async function cleanupFaultModels(page: Page, models: readonly FaultModelDefinition[]) {
  const results = await cleanupEntries(
    page,
    models.map((expected) => ({ expected })),
  )
  assertCleanup(results)
  return results
}

function assertCleanup(results: FaultCleanupResult[]) {
  const failed = results.filter((result) => result.status === 'failed')
  if (failed.length)
    throw new Error(
      `Fault model cleanup failed (resources ${failed.map((result) => result.id ?? result.key).join(', ')})`,
    )
}

export async function withFaultModels<T>(
  page: Page,
  models: readonly FaultModelDefinition[],
  run: () => Promise<T>,
  onCleanup?: (results: FaultCleanupResult[]) => Promise<void>,
): Promise<T> {
  const entries: CleanupEntry[] = []
  let originalError: unknown
  let failed = false
  let value: T | undefined
  let cleanupError: AggregateError | undefined
  try {
    for (const model of models) {
      let row = await readFaultModel(model)
      if (row) verifyConfiguration(row, model)
      // 先核对已有资源，再登记 key；写入响应丢失时 finally 仍能只读恢复 ID。
      const entry: CleanupEntry = { expected: model, ...(row ? { id: row.id } : {}) }
      entries.push(entry)
      if (!row) {
        await createAcceptanceModel(page, model, true)
        row = await readFaultModel(model)
        if (!row) throw new Error('Created fault model could not be confirmed')
        entry.id = row.id
        verifyConfiguration(row, model)
      } else if (!row.enabled) {
        const editor = await faultModelEditor(page, model, row.id)
        await editor.getByRole('button', { name: 'Enable', exact: true }).click()
        await expect(editor.getByRole('status')).toHaveText('Saved.')
      }
      const ready = await readFaultModel(model)
      if (!ready) throw new Error('Prepared fault model could not be confirmed')
      verifyConfiguration(ready, model)
      if (!ready.enabled) throw new Error(`Fault model was not enabled (resource ${ready.id})`)
    }
    value = await run()
  } catch (error) {
    failed = true
    originalError = error
  } finally {
    const results = await cleanupEntries(page, entries)
    const errors: unknown[] = []
    try {
      assertCleanup(results)
    } catch (error) {
      errors.push(error)
    }
    try {
      await onCleanup?.(results)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      cleanupError = new AggregateError(
        [...(failed ? [originalError] : []), ...errors],
        `Fault run cleanup or evidence failed (resources ${results.map((result) => result.id ?? result.key).join(', ')})`,
      )
  }
  if (cleanupError) throw cleanupError
  if (failed) throw originalError
  return value as T
}
