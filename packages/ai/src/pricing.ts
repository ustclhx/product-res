import type { AiModality } from '@product-res/config'
import { z } from 'zod'

/**
 * 模型计费方式（docs/06-ai.md §2「计费方式」）：校验 `ai_model.pricing`，并计算预扣额与结算额。
 * 全部是纯函数；调用方只传入发起时保存的定价快照（`ai_message.pricing` / `ai_task.pricing`）。
 * 结果一律向上取整为整数积分，且落在积分账本 int4 列的范围内。
 */

export type { AiModality }

/** 参数名 → 取值 → 倍率，如 `{ resolution: { '720p': 1, '1080p': 2 } }`；多个参数相乘 */
export type Multipliers = Record<string, Record<string, number>>

export type Pricing =
  | {
      mode: 'per_call'
      /** 每轮对话 / 每次生成的积分 */
      credits: number
      multipliers?: Multipliers
      /** 何时计费：媒体默认 success；文本默认 any_output（中断但已有输出也计费） */
      chargeOn?: 'success' | 'any_output'
      /** 文本按轮计费时限制单轮成本上限；文本模型必填 */
      limits?: { maxInputTokens?: number; maxOutputTokens?: number }
    }
  | { mode: 'token'; inputPer1k: number; outputPer1k: number; minCharge?: number }
  | { mode: 'per_unit'; unit: 'image' | 'second'; perUnit: number; multipliers?: Multipliers }

/** 按 token 计费未配置 `minCharge` 时的最低费用（design 决策 4） */
export const DEFAULT_MIN_CHARGE = 1

/** 预扣时已知的请求信息；各计费方式只读取自己需要的字段 */
export interface CreditsEstimateInput {
  /** 请求参数，`per_call` / `per_unit` 按 `multipliers` 加权 */
  params?: Readonly<Record<string, unknown>>
  /** `token`：保守估算的输入 token 数 */
  inputTokens?: number
  /** `token`：本次允许的最大输出 token 数 */
  maxOutputTokens?: number
  /** `per_unit`：请求的张数 / 秒数 */
  units?: number
}

/** 结算时的实际用量；`params` 须与预扣时相同 */
export interface CreditsUsage {
  params?: Readonly<Record<string, unknown>>
  /** `token`：实际输入 token 数 */
  inputTokens?: number
  /** `token`：实际输出 token 数 */
  outputTokens?: number
  /** `per_unit`：服务商回报的张数 / 秒数 */
  units?: number
}

export type PricingErrorCode =
  | 'INVALID_PRICING'
  | 'MISSING_TOKEN_LIMITS'
  | 'INVALID_USAGE'
  | 'UNKNOWN_MULTIPLIER_VALUE'
  | 'CREDITS_OUT_OF_RANGE'

export class PricingError extends Error {
  readonly code: PricingErrorCode

  constructor(code: PricingErrorCode, message: string = code) {
    super(message)
    this.code = code
    this.name = 'PricingError'
  }
}

// 与 packages/credits 的金额上限一致（PostgreSQL int4）
const MAX_CREDITS = 2_147_483_647

const price = z.number().finite().nonnegative()
const positive = z.number().finite().positive()
const tokenLimit = z.number().int().positive()
const multipliers = z.record(z.string(), z.record(z.string(), positive))

const pricingSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('per_call'),
    credits: positive,
    multipliers: multipliers.optional(),
    chargeOn: z.enum(['success', 'any_output']).optional(),
    limits: z
      .strictObject({
        maxInputTokens: tokenLimit.optional(),
        maxOutputTokens: tokenLimit.optional(),
      })
      .optional(),
  }),
  z.strictObject({
    mode: z.literal('token'),
    inputPer1k: price,
    outputPer1k: price,
    minCharge: z.number().int().positive().optional(),
  }),
  z.strictObject({
    mode: z.literal('per_unit'),
    unit: z.enum(['image', 'second']),
    perUnit: positive,
    multipliers: multipliers.optional(),
  }),
])

/**
 * 校验后台保存或快照读出的定价，失败时抛出 `PricingError`。
 * 按次计费的文本模型必须同时配置 `limits.maxInputTokens` 与 `limits.maxOutputTokens`。
 */
export function parsePricing(input: unknown, modality: AiModality): Pricing {
  const result = pricingSchema.safeParse(input)
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)')
    throw new PricingError('INVALID_PRICING', `Invalid pricing: ${[...new Set(paths)].join(', ')}`)
  }
  // zod 不会输出值为 undefined 的可选字段，满足 exactOptionalPropertyTypes 下的 Pricing
  const pricing = result.data as Pricing
  if (
    modality === 'text' &&
    pricing.mode === 'per_call' &&
    (pricing.limits?.maxInputTokens === undefined || pricing.limits.maxOutputTokens === undefined)
  ) {
    throw new PricingError('MISSING_TOKEN_LIMITS')
  }
  return pricing
}

/** 预扣额：`per_call` 为固定值，`token` 按输入估算与最大输出取上限，`per_unit` 按请求的用量计算 */
export function estimateCredits(pricing: Pricing, input: CreditsEstimateInput): number {
  switch (pricing.mode) {
    case 'per_call':
      return perCallCredits(pricing, input.params)
    case 'token':
      return tokenCredits(pricing, input.inputTokens, input.maxOutputTokens)
    case 'per_unit':
      return perUnitCredits(pricing, input.units, input.params)
  }
}

/**
 * 结算额：`per_call` 等于预扣值（同一快照与参数），`token` 按实际 usage 且不低于 `minCharge`，
 * `per_unit` 按服务商回报的用量。是否应当计费（如按次无输出时释放）由调用方按 `chargeOn` 判断。
 */
export function actualCredits(pricing: Pricing, usage: CreditsUsage): number {
  switch (pricing.mode) {
    case 'per_call':
      return perCallCredits(pricing, usage.params)
    case 'token':
      return tokenCredits(pricing, usage.inputTokens, usage.outputTokens)
    case 'per_unit':
      return perUnitCredits(pricing, usage.units, usage.params)
  }
}

function perCallCredits(
  pricing: Extract<Pricing, { mode: 'per_call' }>,
  params: CreditsEstimateInput['params'],
) {
  return toCredits(pricing.credits * multiplierOf(pricing.multipliers, params))
}

function tokenCredits(
  pricing: Extract<Pricing, { mode: 'token' }>,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
) {
  const input = tokenCount(inputTokens)
  const output = tokenCount(outputTokens)
  // 先合计再取整：预扣（最大输出）与结算（实际输出 ≤ 最大输出）的取整口径一致，结算不会超过预扣
  const cost = (input * pricing.inputPer1k + output * pricing.outputPer1k) / 1000
  return Math.max(toCredits(cost), pricing.minCharge ?? DEFAULT_MIN_CHARGE)
}

function perUnitCredits(
  pricing: Extract<Pricing, { mode: 'per_unit' }>,
  units: number | undefined,
  params: CreditsEstimateInput['params'],
) {
  if (units === undefined || !Number.isFinite(units) || units < 0) {
    throw new PricingError('INVALID_USAGE', 'units must be a non-negative number')
  }
  return toCredits(units * pricing.perUnit * multiplierOf(pricing.multipliers, params))
}

function tokenCount(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new PricingError('INVALID_USAGE', 'token counts must be non-negative integers')
  }
  return value
}

/** 未传的参数按倍率 1 处理；传了但不在倍率表中的取值视为配置错误，避免少收 */
function multiplierOf(table: Multipliers | undefined, params: CreditsEstimateInput['params']) {
  let factor = 1
  for (const [name, values] of Object.entries(table ?? {})) {
    const value = params?.[name]
    if (value === undefined) continue
    const rate =
      typeof value === 'string' || typeof value === 'number' ? values[String(value)] : undefined
    if (rate === undefined) {
      throw new PricingError('UNKNOWN_MULTIPLIER_VALUE', `No multiplier for ${name}`)
    }
    factor *= rate
  }
  return factor
}

function toCredits(amount: number) {
  // 先消掉浮点误差（如 0.1 + 0.2）再向上取整，避免多收 1 积分
  const credits = Math.ceil(Math.round(amount * 1e6) / 1e6)
  if (!Number.isSafeInteger(credits) || credits > MAX_CREDITS) {
    throw new PricingError('CREDITS_OUT_OF_RANGE')
  }
  return credits
}
