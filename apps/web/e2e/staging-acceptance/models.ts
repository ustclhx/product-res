import type { Page } from '@playwright/test'
import type { Pricing } from '@product-res/ai'
import { evidence, expect, query, sqlLiteral, test } from './support.ts'

const prompt = 'A red square on a plain white background'
const promptProperty = { type: 'string', title: 'Prompt', minLength: 1, maxLength: 1000 }

export const workersImage = {
  key: 'acceptance-workers-image',
  kind: 'image',
  provider: 'workers-ai',
  providerModelId: '@cf/black-forest-labs/flux-1-schnell',
  pricing: { mode: 'per_call', credits: 1, chargeOn: 'success' },
  sort: -1000,
  params: { prompt, steps: 1 },
  paramsSchema: {
    type: 'object',
    properties: {
      prompt: promptProperty,
      steps: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
} as const

export const falImage = {
  key: 'acceptance-fal-image',
  kind: 'image',
  provider: 'fal',
  providerModelId: 'fal-ai/flux/schnell',
  pricing: { mode: 'per_call', credits: 2, chargeOn: 'success' },
  sort: -999,
  // 平面参数表单使用枚举尺寸，服务商 ID 与其余输入取自已录制的夹具。
  params: {
    prompt,
    image_size: 'square',
    num_images: 1,
    num_inference_steps: 1,
    output_format: 'png',
    seed: 42,
    enable_safety_checker: true,
  },
  paramsSchema: {
    type: 'object',
    properties: {
      prompt: promptProperty,
      image_size: { type: 'string', enum: ['square'], default: 'square' },
      num_images: { type: 'integer', minimum: 1, maximum: 1, default: 1 },
      num_inference_steps: { type: 'integer', minimum: 1, maximum: 4, default: 1 },
      output_format: { type: 'string', enum: ['png'], default: 'png' },
      seed: { type: 'integer', minimum: 0, default: 42 },
      enable_safety_checker: { type: 'boolean', default: true },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
} as const

export const falVideo = {
  key: 'acceptance-fal-video',
  kind: 'video',
  provider: 'fal',
  providerModelId: 'fal-ai/wan/v2.2-a14b/text-to-video/turbo',
  pricing: { mode: 'per_call', credits: 3, chargeOn: 'success' },
  sort: -998,
  params: { prompt, resolution: '480p', enable_prompt_expansion: false },
  paramsSchema: {
    type: 'object',
    properties: {
      prompt: promptProperty,
      resolution: { type: 'string', enum: ['480p'], default: '480p' },
      enable_prompt_expansion: { type: 'boolean', default: false },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
} as const

export const deepseekToken = {
  key: 'acceptance-deepseek-token',
  kind: 'text',
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 2, minCharge: 1 },
  sort: -997,
  paramsSchema: {},
} as const

export const deepseekCall = {
  key: 'acceptance-deepseek-call',
  kind: 'text',
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: {
    mode: 'per_call',
    credits: 2,
    chargeOn: 'any_output',
    limits: { maxInputTokens: 4096, maxOutputTokens: 1024 },
  },
  sort: -996,
  paramsSchema: {},
} as const

export const ACCEPTANCE_MODELS = [workersImage, falImage, falVideo, deepseekToken, deepseekCall]
type Model = (typeof ACCEPTANCE_MODELS)[number]
type ModelRow = Record<string, unknown> & { id: string }

async function readModel(model: Model) {
  return query<ModelRow>(`select id, key, kind, provider, provider_model_id, pricing,
    min_plan_features, params_schema, enabled, sort from ai_model
    where key = ${sqlLiteral(model.key)}`)
}

export async function verifyAcceptanceModel(model: Model) {
  const rows = await readModel(model)
  expect(rows, `Expected one configured acceptance model: ${model.key}`).toHaveLength(1)
  const row = rows[0] as ModelRow
  expect(row).toEqual({
    id: expect.any(String),
    key: model.key,
    kind: model.kind,
    provider: model.provider,
    provider_model_id: model.providerModelId,
    pricing: model.pricing,
    min_plan_features: [],
    params_schema: model.paramsSchema,
    enabled: true,
    sort: model.sort,
  })
  return row
}

export interface AcceptanceModelDefinition {
  key: string
  kind: 'text' | 'image' | 'video'
  provider: string
  providerModelId: string
  pricing: Pricing
  sort: number
  paramsSchema: Record<string, unknown>
  tags?: readonly string[]
}

// 两类验收共用已有后台表单；故障场景要求 schema 字段存在，不允许跳过。
export async function createAcceptanceModel(
  page: Page,
  model: AcceptanceModelDefinition,
  requireSchema = false,
) {
  if (model.pricing.mode === 'per_unit')
    throw new Error('Acceptance model setup does not support per-unit pricing')
  await page.goto('/admin/models')
  await expect(page.getByRole('heading', { name: 'AI models', exact: true })).toBeVisible()
  // 新建表单默认收起；按钮在水合后才可用，点击后表单出现
  await page.getByRole('button', { name: 'New model', exact: true }).click()
  const form = page.getByRole('article', { name: 'New model', exact: true })
  await expect(form).toBeVisible()
  const schema = form.getByLabel('Parameters schema (JSON)', { exact: true })
  if (requireSchema && (await schema.count()) === 0)
    throw new Error('Fault model preparation requires the parameter schema editor')
  test.skip(
    model.kind !== 'text' && (await schema.count()) === 0,
    'Media model setup requires the admin Parameters schema (JSON) field; current UI cannot create a usable media model.',
  )
  // 新表单默认文本按 token 计费；动态按次字段出现才能证明 React 已接管。
  // 每次只切换一个状态并等待渲染，避免同一轮反复改 Kind 后立即检查旧 DOM。
  await expect
    .poll(async () => {
      await form.getByLabel('Pricing mode').selectOption('per_call')
      return form.getByLabel('Credits per call', { exact: true }).isVisible()
    })
    .toBe(true)
  await form.getByLabel('Kind').selectOption(model.kind)
  await expect(form.locator('#new-provider')).toHaveJSProperty(
    'tagName',
    model.kind === 'text' ? 'INPUT' : 'SELECT',
  )
  await form.getByLabel('Pricing mode').selectOption(model.pricing.mode)
  await expect(
    form.getByLabel(model.pricing.mode === 'token' ? 'Input credits / 1k' : 'Credits per call', {
      exact: true,
    }),
  ).toBeVisible()
  await form.getByLabel('Key', { exact: true }).fill(model.key)
  const provider = form.locator('#new-provider')
  if (model.kind === 'text') await provider.fill(model.provider)
  else await provider.selectOption(model.provider)
  await form.getByLabel('Provider model ID', { exact: true }).fill(model.providerModelId)
  await form
    .getByLabel('Plan tags (comma separated)', { exact: true })
    .fill((model.tags ?? []).join(','))
  await form.getByLabel('Sort', { exact: true }).fill(String(model.sort))
  await form.getByLabel('Enabled', { exact: true }).check()
  if (await schema.count()) await schema.fill(JSON.stringify(model.paramsSchema))
  if (model.pricing.mode === 'token') {
    await form
      .getByLabel('Input credits / 1k', { exact: true })
      .fill(String(model.pricing.inputPer1k))
    await form
      .getByLabel('Output credits / 1k', { exact: true })
      .fill(String(model.pricing.outputPer1k))
    await form.getByLabel('Minimum charge', { exact: true }).fill(String(model.pricing.minCharge))
  } else {
    await form.getByLabel('Credits per call', { exact: true }).fill(String(model.pricing.credits))
    await form.getByLabel('Charge on').selectOption(model.pricing.chargeOn ?? '')
    await form.getByLabel('Multipliers (JSON, optional)', { exact: true }).fill('')
    await form
      .getByLabel('Max input tokens', { exact: true })
      .fill(
        model.pricing.limits?.maxInputTokens === undefined
          ? ''
          : String(model.pricing.limits.maxInputTokens),
      )
    await form
      .getByLabel('Max output tokens', { exact: true })
      .fill(
        model.pricing.limits?.maxOutputTokens === undefined
          ? ''
          : String(model.pricing.limits.maxOutputTokens),
      )
  }
  await form.getByRole('button', { name: 'Create model', exact: true }).click()
  await expect(form.getByRole('status')).toHaveText('Saved.')
}

export async function ensureAcceptanceModels(
  page: Page,
  models: readonly Model[] = ACCEPTANCE_MODELS,
) {
  for (const model of models) {
    const existing = await readModel(model)
    if (existing.length === 0) {
      await createAcceptanceModel(page, model)
      await expect.poll(async () => (await readModel(model)).length).toBe(1)
    }
    const row = await verifyAcceptanceModel(model)
    const audit = await query<{ id: string }>(`select id from audit_log
      where action='ai.model_created' and target_id=${sqlLiteral(row.id)} order by id desc limit 1`)
    if (existing.length === 0) expect(audit).toHaveLength(1)
    await evidence(`model-${model.key}`, {
      modelId: row.id,
      modelKey: model.key,
      status: existing.length ? 'verified-existing' : 'created',
      pricing: model.pricing,
      auditIds: audit.map((item) => item.id),
      parameterSchemaStatus: model.paramsSchema ? 'configured' : 'not-required',
    })
  }
}
