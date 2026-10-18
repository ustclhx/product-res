import type { PricingMode } from '@product-res/config'
import { type AiModel, aiModel, type Database, type NewAiModel } from '@product-res/db'
import { can, type Entitlements, requireEntitlement } from '@product-res/entitlements'
import { AppError } from '@product-res/shared'
import { and, asc, eq } from 'drizzle-orm'
import { ACCEPTANCE_FAULT_INVALID, type FaultAccessContext, parseAcceptanceFault } from './fault.ts'
import { type AiModality, type Pricing, PricingError, parsePricing } from './pricing.ts'

/**
 * 模型注册表的读取（docs/06-ai.md §2，specs/ai-model-registry「模型可见性」）。
 *
 * - 列表（展示与选择）：只含已启用的模型，经 KV 缓存；后台保存后调用 `invalidateModelCache`。
 * - 调用前取模型（`requireAvailableModel`）：直接读库、不走缓存，停用后立即拒绝，
 *   返回的 `pricing` 即发起调用时应写入的定价快照。
 */

/** 校验过计费方式的已启用模型 */
export interface AvailableModel {
  readonly id: string
  readonly key: string
  readonly kind: AiModality
  readonly provider: string
  readonly providerModelId: string
  readonly pricing: Pricing
  /** 与 `plan.features.models` 匹配的标签（`ai_model.min_plan_features`） */
  readonly tags: readonly string[]
  readonly paramsSchema: Record<string, unknown> | null
  readonly sort: number
}

/** 读取模型的来源，生产中为数据库（`dbModelStore`），测试中可替换 */
export interface ModelStore {
  /** 全部已启用模型，按 sort 排序 */
  listEnabled(): Promise<AiModel[]>
  /** 按 id 取已启用模型；不存在或已停用返回 `undefined` */
  findEnabled(id: string): Promise<AiModel | undefined>
}

/** 模型列表缓存，生产中由 KV 实现（`KVNamespace` 结构兼容） */
export interface ModelCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface ModelRegistryContext {
  store: ModelStore
  cache?: ModelCache | undefined
  /** 目标未装配 Workers AI 时显式传 false；省略保留既有调用方行为。 */
  workersAi?: boolean | undefined
  faultAccess?: FaultAccessContext | undefined
}

export const MODEL_CACHE_KEY = 'ai:models'
/** KV 允许的最小 TTL；后台保存时主动失效，TTL 只兜底其他地域的旧副本 */
export const MODEL_CACHE_TTL_SECONDS = 60

export const MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE'

const providerAvailable = (ctx: Pick<ModelRegistryContext, 'workersAi'>, provider: string) =>
  provider !== 'workers-ai' || ctx.workersAi !== false

export function dbModelStore(db: Database): ModelStore {
  return {
    listEnabled: () =>
      db
        .select()
        .from(aiModel)
        .where(eq(aiModel.enabled, true))
        .orderBy(asc(aiModel.sort), asc(aiModel.key)),
    async findEnabled(id) {
      const rows = await db
        .select()
        .from(aiModel)
        .where(and(eq(aiModel.id, id), eq(aiModel.enabled, true)))
        .limit(1)
      return rows[0]
    },
  }
}

/** 行 → 可用模型；计费方式不合法（如按次文本模型缺 token 上限）的行视为不可用 */
function toAvailable(row: AiModel): AvailableModel | undefined {
  let pricing: Pricing
  try {
    pricing = parsePricing(row.pricing, row.kind)
    parseAcceptanceFault(row)
  } catch (error) {
    if (error instanceof PricingError) return undefined
    if (error instanceof AppError && error.code === ACCEPTANCE_FAULT_INVALID) return undefined
    throw error
  }
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    provider: row.provider,
    providerModelId: row.providerModelId,
    pricing,
    tags: row.minPlanFeatures,
    paramsSchema: row.paramsSchema ?? null,
    sort: row.sort,
  }
}

function faultAvailable(
  ctx: Pick<ModelRegistryContext, 'faultAccess'>,
  model: AvailableModel,
): boolean {
  try {
    return (
      parseAcceptanceFault(model) === undefined ||
      (ctx.faultAccess?.enabled === true && ctx.faultAccess.platformAdmin === true)
    )
  } catch (error) {
    if (error instanceof AppError && error.code === ACCEPTANCE_FAULT_INVALID) return false
    throw error
  }
}

/** 当前目标可用的已启用模型（不按权益过滤），优先读缓存 */
export async function listEnabledModels(ctx: ModelRegistryContext): Promise<AvailableModel[]> {
  const cached = await ctx.cache?.get(MODEL_CACHE_KEY)
  if (cached != null)
    return (JSON.parse(cached) as AvailableModel[]).filter(
      (model) => providerAvailable(ctx, model.provider) && faultAvailable(ctx, model),
    )
  const models = (await ctx.store.listEnabled()).flatMap((row) => toAvailable(row) ?? [])
  await ctx.cache?.put(MODEL_CACHE_KEY, JSON.stringify(models), {
    expirationTtl: MODEL_CACHE_TTL_SECONDS,
  })
  // 缓存保留完整注册表，每次读取后按目标、环境和身份过滤，避免共享缓存串权。
  return models.filter(
    (model) => providerAvailable(ctx, model.provider) && faultAvailable(ctx, model),
  )
}

const allowed = (entitlements: Entitlements, model: AvailableModel) =>
  can(entitlements, 'ai.useModel', { modelKey: model.key, tags: model.tags })

/** 空间当前权益允许且已启用的模型，供模型选择器展示 */
export async function listAvailableModels(
  ctx: ModelRegistryContext,
  entitlements: Entitlements,
  options: { readonly kind?: AiModality } = {},
): Promise<AvailableModel[]> {
  const models = await listEnabledModels(ctx)
  return models.filter(
    (model) =>
      (options.kind === undefined || model.kind === options.kind) && allowed(entitlements, model),
  )
}

/**
 * 发起调用前按 id 取模型：不存在、已停用、目标能力缺失或计费方式不合法时抛出 `MODEL_UNAVAILABLE`（404），
 * 权益不允许时抛出 `UPGRADE_REQUIRED`（403）。直接读库，不受列表缓存延迟影响。
 */
export async function requireAvailableModel(
  ctx: Pick<ModelRegistryContext, 'store' | 'workersAi' | 'faultAccess'>,
  entitlements: Entitlements,
  id: string,
): Promise<AvailableModel> {
  const row = await ctx.store.findEnabled(id)
  const model = row && toAvailable(row)
  if (!model || !faultAvailable(ctx, model))
    throw new AppError(MODEL_UNAVAILABLE, 'Model is not available', { status: 404 })
  if (!providerAvailable(ctx, model.provider))
    throw new AppError(MODEL_UNAVAILABLE, 'Workers AI is not available on this runtime', {
      status: 404,
    })
  requireEntitlement(entitlements, {
    capability: 'ai.useModel',
    modelKey: model.key,
    tags: model.tags,
  })
  return model
}

/** 后台保存模型后调用，使列表缓存立即失效 */
export async function invalidateModelCache(cache: ModelCache | undefined): Promise<void> {
  await cache?.delete(MODEL_CACHE_KEY)
}

/**
 * 新建模型时预填的计费方式（specs/ai-model-registry「新模型的默认计费方式」）：
 * 方式取模板配置 `ai.defaultPricingMode[kind]`，数值为占位，由管理员填写。
 * 按次文本模型不预填 token 上限，管理员必须显式填写才能保存。
 */
export function defaultPricing(
  kind: AiModality,
  modes: { readonly [M in AiModality]: PricingMode },
): Pricing {
  switch (modes[kind]) {
    case 'per_call':
      return { mode: 'per_call', credits: 1, chargeOn: kind === 'text' ? 'any_output' : 'success' }
    case 'token':
      return { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 }
    case 'per_unit':
      return { mode: 'per_unit', unit: kind === 'video' ? 'second' : 'image', perUnit: 1 }
  }
}

/** 后台保存模型时提交的字段 */
export interface ModelInput {
  readonly key: string
  readonly kind: AiModality
  readonly provider: string
  readonly providerModelId: string
  readonly pricing: unknown
  readonly tags: readonly string[]
  readonly enabled: boolean
  readonly sort: number
  readonly paramsSchema?: Record<string, unknown> | null | undefined
}

/**
 * 校验后台提交的模型并返回要写入 `ai_model` 的字段。计费方式经 `parsePricing` 校验，
 * 不合法时抛出 `PricingError`（如按次文本模型缺 token 上限：`MISSING_TOKEN_LIMITS`），保存被拒绝。
 */
export function modelValues(input: ModelInput) {
  const pricing = parsePricing(input.pricing, input.kind)
  parseAcceptanceFault({
    ...input,
    key: input.key.trim(),
    provider: input.provider.trim(),
    providerModelId: input.providerModelId.trim(),
  })
  return {
    key: input.key.trim(),
    kind: input.kind,
    provider: input.provider.trim(),
    providerModelId: input.providerModelId.trim(),
    pricing,
    minPlanFeatures: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    enabled: input.enabled,
    sort: input.sort,
  } satisfies Partial<NewAiModel>
}
