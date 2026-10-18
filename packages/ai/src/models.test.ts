import type { AiModel } from '@product-res/db'
import {
  DEFAULT_FREE_FEATURES,
  type Entitlements,
  UPGRADE_REQUIRED,
} from '@product-res/entitlements'
import { AppError } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_FAULT_INVALID,
  type AcceptanceFaultMode,
  parseAcceptanceFault,
} from './fault.ts'
import {
  defaultPricing,
  invalidateModelCache,
  listAvailableModels,
  MODEL_CACHE_KEY,
  MODEL_CACHE_TTL_SECONDS,
  MODEL_UNAVAILABLE,
  type ModelCache,
  type ModelStore,
  modelValues,
  requireAvailableModel,
} from './models.ts'
import { PricingError } from './pricing.ts'

function row(overrides: Partial<AiModel> & Pick<AiModel, 'id' | 'key'>): AiModel {
  return {
    kind: 'text',
    provider: 'openai',
    providerModelId: overrides.key,
    pricing: { mode: 'token', inputPer1k: 2, outputPer1k: 8 },
    minPlanFeatures: [],
    paramsSchema: null,
    enabled: true,
    sort: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

/** 模拟 ai_model 表：只返回 enabled 的行，与 dbModelStore 的查询条件一致 */
function memoryStore(rows: AiModel[]) {
  let listCalls = 0
  const store: ModelStore = {
    async listEnabled() {
      listCalls++
      return rows.filter((r) => r.enabled).sort((a, b) => a.sort - b.sort)
    },
    async findEnabled(id) {
      return rows.find((r) => r.id === id && r.enabled)
    },
  }
  return { store, rows, listCalls: () => listCalls }
}

function memoryCache() {
  const data = new Map<string, string>()
  const ttls: (number | undefined)[] = []
  const cache: ModelCache = {
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value, options) {
      data.set(key, value)
      ttls.push(options?.expirationTtl)
    },
    async delete(key) {
      data.delete(key)
    },
  }
  return { cache, data, ttls }
}

const plan = (models: string[]): Entitlements => ({
  key: 'pro',
  sort: 1,
  features: { ...DEFAULT_FREE_FEATURES, models },
})
const all = plan(['*'])

function faultRow(mode: AcceptanceFaultMode = 'chat-before-stream'): AiModel {
  return row({
    id: 'fault',
    key: `acceptance-fault-${mode}`,
    provider: 'deepseek',
    providerModelId: 'deepseek-flash',
    paramsSchema: { 'x-acceptance-fault': { mode } },
  })
}

describe('parseAcceptanceFault', () => {
  it('只接受与指定 Provider、种类和模型配对的九个模式', () => {
    const modes: AcceptanceFaultMode[] = [
      'workers-error',
      'workers-timeout',
      'fal-callback-lost',
      'fal-callback-early',
      'fal-submit-response-lost',
      'fal-provider-error',
      'fal-timeout',
      'chat-before-stream',
      'chat-mid-stream',
    ]
    for (const mode of modes) {
      const model = faultRow(mode)
      const paired = mode.startsWith('workers-')
        ? {
            ...model,
            kind: 'image' as const,
            provider: 'workers-ai',
            providerModelId: '@cf/black-forest-labs/flux-1-schnell',
          }
        : mode.startsWith('fal-')
          ? {
              ...model,
              kind: 'image' as const,
              provider: 'fal',
              providerModelId: 'fal-ai/flux/schnell',
            }
          : model
      expect(parseAcceptanceFault(paired)).toEqual({ mode })
      for (const invalid of [
        { ...paired, provider: 'openai' },
        { ...paired, kind: 'video' as const },
        { ...paired, providerModelId: 'other-model' },
      ])
        expect(() => parseAcceptanceFault(invalid)).toThrow(
          expect.objectContaining({ code: ACCEPTANCE_FAULT_INVALID }),
        )
    }
    expect(parseAcceptanceFault(row({ id: 'normal', key: 'normal' }))).toBeUndefined()
  })

  it('半配置、未知模式和请求可调策略都拒绝，不降级为普通模型', () => {
    for (const invalid of [
      { ...faultRow(), paramsSchema: null },
      { ...faultRow(), key: 'normal' },
      { ...faultRow(), paramsSchema: { 'x-acceptance-fault': undefined } },
      { ...faultRow(), paramsSchema: { 'x-acceptance-fault': { mode: 'unknown' } } },
      {
        ...faultRow(),
        paramsSchema: { 'x-acceptance-fault': { mode: 'chat-mid-stream', deadline: 1 } },
      },
    ])
      expect(() => parseAcceptanceFault(invalid)).toThrow(
        expect.objectContaining({ code: ACCEPTANCE_FAULT_INVALID }),
      )
  })
})

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

describe('listAvailableModels', () => {
  it('完整注册表缓存每次按故障权限过滤，任一闸门缺失均隐藏且不影响正常模型', async () => {
    for (const adminFirst of [true, false]) {
      const { store, listCalls } = memoryStore([row({ id: 'normal', key: 'normal' }), faultRow()])
      const { cache, data } = memoryCache()
      const keys = async (faultAccess?: { enabled: boolean; platformAdmin: boolean }) =>
        (await listAvailableModels({ store, cache, faultAccess }, all)).map((model) => model.key)
      const authorized = { enabled: true, platformAdmin: true }
      expect(await keys(adminFirst ? authorized : undefined)).toHaveLength(adminFirst ? 2 : 1)
      expect(await keys(adminFirst ? undefined : authorized)).toHaveLength(adminFirst ? 1 : 2)
      for (const faultAccess of [
        { enabled: false, platformAdmin: true },
        { enabled: true, platformAdmin: false },
      ])
        expect(await keys(faultAccess)).toEqual(['normal'])
      expect(JSON.parse(data.get(MODEL_CACHE_KEY) ?? '[]')).toHaveLength(2)
      expect(listCalls()).toBe(1)
    }
  })

  it('无效故障注册项即使在旧缓存中也不会出现', async () => {
    const invalid = { ...faultRow(), paramsSchema: null }
    const { store } = memoryStore([invalid])
    const { cache, data } = memoryCache()
    const ctx = { store, cache, faultAccess: { enabled: true, platformAdmin: true } }
    expect(await listAvailableModels(ctx, all)).toEqual([])
    data.set(MODEL_CACHE_KEY, JSON.stringify([{ ...invalid, tags: [] }]))
    expect(await listAvailableModels(ctx, all)).toEqual([])
  })

  it('按当前目标能力过滤 Workers AI，缓存不被目标过滤结果污染', async () => {
    for (const firstWorkersAi of [true, false]) {
      const { store, listCalls } = memoryStore([
        row({ id: 'm1', key: 'gpt-a' }),
        row({ id: 'm2', key: 'flux', kind: 'image', provider: 'workers-ai', sort: 1 }),
      ])
      const { cache } = memoryCache()
      const keys = async (workersAi: boolean) =>
        (await listAvailableModels({ store, cache, workersAi }, all)).map((model) => model.key)
      expect(await keys(firstWorkersAi)).toEqual(firstWorkersAi ? ['gpt-a', 'flux'] : ['gpt-a'])
      expect(await keys(!firstWorkersAi)).toEqual(firstWorkersAi ? ['gpt-a'] : ['gpt-a', 'flux'])
      expect(listCalls()).toBe(1)
    }
  })

  it('停用模型不出现在列表中', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a' }),
      row({ id: 'm2', key: 'gpt-b', enabled: false }),
    ])
    const models = await listAvailableModels({ store }, all)
    expect(models.map((m) => m.key)).toEqual(['gpt-a'])
  })

  it('按空间权益过滤：模型 key 或标签匹配 plan.features.models', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a', sort: 1 }),
      row({ id: 'm2', key: 'claude-b', minPlanFeatures: ['premium'], sort: 2 }),
      row({ id: 'm3', key: 'flux', kind: 'image', sort: 3 }),
    ])
    expect((await listAvailableModels({ store }, plan(['gpt-a']))).map((m) => m.key)).toEqual([
      'gpt-a',
    ])
    expect((await listAvailableModels({ store }, plan(['premium']))).map((m) => m.key)).toEqual([
      'claude-b',
    ])
    expect(await listAvailableModels({ store }, plan([]))).toEqual([])
    expect(
      (await listAvailableModels({ store }, all, { kind: 'image' })).map((m) => m.key),
    ).toEqual(['flux'])
  })

  it('计费方式不合法的模型不出现在列表中', async () => {
    const { store } = memoryStore([
      row({ id: 'm1', key: 'gpt-a', pricing: { mode: 'per_call', credits: 1 } }),
    ])
    expect(await listAvailableModels({ store }, all)).toEqual([])
  })

  it('命中缓存时不再查库，失效后重新读取', async () => {
    const { store, rows, listCalls } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const { cache, data, ttls } = memoryCache()
    const ctx = { store, cache }

    expect((await listAvailableModels(ctx, all)).map((m) => m.key)).toEqual(['gpt-a'])
    expect(listCalls()).toBe(1)
    expect(data.has(MODEL_CACHE_KEY)).toBe(true)
    expect(ttls).toEqual([MODEL_CACHE_TTL_SECONDS])

    // 后台停用后、失效前：仍返回缓存内容，不查库
    rows[0] = row({ id: 'm1', key: 'gpt-a', enabled: false })
    expect((await listAvailableModels(ctx, all)).map((m) => m.key)).toEqual(['gpt-a'])
    expect(listCalls()).toBe(1)

    await invalidateModelCache(cache)
    expect(await listAvailableModels(ctx, all)).toEqual([])
    expect(listCalls()).toBe(2)
  })

  it('权益过滤在缓存之后进行，不同空间共享同一份缓存', async () => {
    const { store, listCalls } = memoryStore([
      row({ id: 'm1', key: 'gpt-a' }),
      row({ id: 'm2', key: 'gpt-b' }),
    ])
    const { cache } = memoryCache()
    expect(await listAvailableModels({ store, cache }, plan(['gpt-a']))).toHaveLength(1)
    expect(await listAvailableModels({ store, cache }, all)).toHaveLength(2)
    expect(listCalls()).toBe(1)
  })
})

describe('requireAvailableModel', () => {
  it('直接调用重新核验故障授权与当前配置，列表缓存不能授权或复活停用模型', async () => {
    const { store, rows } = memoryStore([faultRow()])
    const { cache } = memoryCache()
    const faultAccess = { enabled: true, platformAdmin: true }
    const ctx = { store, cache, faultAccess }
    await listAvailableModels(ctx, all)
    expect(await requireAvailableModel(ctx, all, 'fault')).toMatchObject({ id: 'fault' })
    for (const denied of [
      undefined,
      { enabled: false, platformAdmin: true },
      { enabled: true, platformAdmin: false },
    ])
      expect(
        (await rejection(requireAvailableModel({ store, faultAccess: denied }, all, 'fault'))).code,
      ).toBe(MODEL_UNAVAILABLE)
    expect((await rejection(requireAvailableModel(ctx, plan([]), 'fault'))).code).toBe(
      UPGRADE_REQUIRED,
    )
    rows[0] = { ...faultRow(), paramsSchema: null }
    expect((await rejection(requireAvailableModel(ctx, all, 'fault'))).code).toBe(MODEL_UNAVAILABLE)
    rows[0] = { ...faultRow(), enabled: false }
    expect((await rejection(requireAvailableModel(ctx, all, 'fault'))).code).toBe(MODEL_UNAVAILABLE)
  })

  it('当前目标缺少 Workers AI 能力时明确拒绝，CF 和原调用方保持可用', async () => {
    const { store } = memoryStore([row({ id: 'm1', key: 'flux', provider: 'workers-ai' })])
    const error = await rejection(requireAvailableModel({ store, workersAi: false }, all, 'm1'))
    expect(error).toMatchObject({
      code: MODEL_UNAVAILABLE,
      status: 404,
      message: 'Workers AI is not available on this runtime',
    })
    expect(await requireAvailableModel({ store, workersAi: true }, all, 'm1')).toMatchObject({
      key: 'flux',
    })
    expect(await requireAvailableModel({ store }, all, 'm1')).toMatchObject({ key: 'flux' })
  })

  it('返回已启用且有权限的模型及其定价快照', async () => {
    const { store } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const model = await requireAvailableModel({ store }, all, 'm1')
    expect(model.key).toBe('gpt-a')
    expect(model.pricing).toEqual({ mode: 'token', inputPer1k: 2, outputPer1k: 8 })
  })

  it('停用模型被拒绝，即使列表缓存中仍有该模型', async () => {
    const { store, rows } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const { cache } = memoryCache()
    await listAvailableModels({ store, cache }, all)
    rows[0] = row({ id: 'm1', key: 'gpt-a', enabled: false })

    const error = await rejection(requireAvailableModel({ store }, all, 'm1'))
    expect(error.code).toBe(MODEL_UNAVAILABLE)
    expect(error.status).toBe(404)
  })

  it('不存在的模型与停用模型返回同样的错误', async () => {
    const { store } = memoryStore([])
    expect((await rejection(requireAvailableModel({ store }, all, 'missing'))).code).toBe(
      MODEL_UNAVAILABLE,
    )
  })

  it('权益不允许的模型被拒绝', async () => {
    const { store } = memoryStore([row({ id: 'm1', key: 'gpt-a' })])
    const error = await rejection(requireAvailableModel({ store }, plan(['other']), 'm1'))
    expect(error.code).toBe(UPGRADE_REQUIRED)
    expect(error.status).toBe(403)
  })
})

describe('defaultPricing', () => {
  it('按模板配置的 ai.defaultPricingMode 预填计费方式', () => {
    const modes = { text: 'token', image: 'per_call', video: 'per_unit' } as const
    expect(defaultPricing('text', modes).mode).toBe('token')
    expect(defaultPricing('image', modes).mode).toBe('per_call')
    expect(defaultPricing('video', modes)).toMatchObject({ mode: 'per_unit', unit: 'second' })
    expect(defaultPricing('text', { ...modes, text: 'per_call' })).toMatchObject({
      mode: 'per_call',
      chargeOn: 'any_output',
    })
  })
})

describe('modelValues', () => {
  const base = {
    key: ' gpt-a ',
    kind: 'text' as const,
    provider: 'openai',
    providerModelId: 'gpt-a',
    tags: ['premium', ' premium ', ''],
    enabled: true,
    sort: 0,
  }

  it('保存缺少 token 上限的按次文本模型被拒绝', () => {
    expect(() => modelValues({ ...base, pricing: { mode: 'per_call', credits: 1 } })).toThrow(
      PricingError,
    )
  })

  it('按次文本模型带 token 上限时可以保存', () => {
    const pricing = {
      mode: 'per_call',
      credits: 1,
      limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
    }
    expect(modelValues({ ...base, pricing })).toMatchObject({
      key: 'gpt-a',
      pricing,
      minPlanFeatures: ['premium'],
    })
  })

  it('不合法的计费方式被拒绝', () => {
    expect(() => modelValues({ ...base, pricing: { mode: 'free' } })).toThrow(PricingError)
  })

  it('后台保存也拒绝缺元数据的专用 key，合法配对可通过共享校验', () => {
    const model = faultRow()
    const input = { ...model, tags: [] }
    expect(modelValues(input)).toMatchObject({ key: model.key })
    expect(() => modelValues({ ...input, paramsSchema: null })).toThrow(
      expect.objectContaining({ code: ACCEPTANCE_FAULT_INVALID }),
    )
  })
})
