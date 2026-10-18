import { AppError } from '@product-res/shared'
import { z } from 'zod'
import type { AvailableModel } from '../models.ts'
import { DEFAULT_MIN_CHARGE, estimateCredits, type Pricing } from '../pricing.ts'

/**
 * 文本调用的预算（docs/06-ai.md §3「流程」第 2 步，design 决策 3）：
 * 保守估算输入 token，按余额确定本次最大输出长度与预扣额。全部是纯函数。
 */

/**
 * 默认每个字符按 1 个 token 估算。常见分词器下英文约 4 字符 / token、中文约 1–1.5 字符 / token，
 * 按字符计数即可覆盖绝大多数文本（宁高勿低）；偏低的模型按模型配置调高系数。
 */
export const DEFAULT_TOKENS_PER_CHAR = 1
/** 每条消息的格式开销（角色标记、分隔符）；同样宁高勿低 */
export const MESSAGE_OVERHEAD_TOKENS = 8
/** 余额只够更短的回复时直接拒绝（docs/06-ai.md §3 的 minOutputTokens） */
export const MIN_OUTPUT_TOKENS = 256
/** 模型未配置输出上限时使用的值 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export const INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS'
export const INPUT_TOO_LONG = 'INPUT_TOO_LONG'

/** 文本模型的估算参数与 Provider 能力声明 */
export interface TextModelConfig {
  /** 输入估算的保守系数：token 数 = 字符数 × 系数 */
  readonly tokensPerChar: number
  /** 模型单次输出上限 */
  readonly maxOutputTokens: number
  /** thinking 能力覆盖；缺省跟随 Provider 适配器，false 禁用 */
  readonly thinking: boolean | undefined
  /** 模型是否支持 Provider 原生续写 */
  readonly continuation: 'native' | 'none'
}

export const textModelConfigSchema = z.strictObject({
  tokensPerChar: z.number().finite().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  thinking: z.boolean().optional(),
  continuation: z.enum(['native', 'none']).optional(),
})

/**
 * 读取模型的文本估算参数：配置在 `ai_model.params_schema` 的 `x-text` 扩展字段
 * （JSON Schema 忽略未知关键字，不影响参数表单），缺失或不合法时取默认值。
 */
export function textModelConfig(model: Pick<AvailableModel, 'paramsSchema'>): TextModelConfig {
  const parsed = textModelConfigSchema.safeParse(model.paramsSchema?.['x-text'])
  const config = parsed.success ? parsed.data : {}
  return {
    tokensPerChar: config.tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    thinking: config.thinking,
    continuation: config.continuation ?? 'none',
  }
}

/** 按字符数保守估算一段文本的 token 数；按码点计数，一个 emoji 不会被算成两个字符 */
export function estimateTextTokens(
  text: string,
  tokensPerChar: number = DEFAULT_TOKENS_PER_CHAR,
): number {
  let chars = 0
  for (const _ of text) chars++
  return Math.ceil(chars * tokensPerChar)
}

/** 估算一组消息（按纯文本内容）的输入 token 数，含每条消息的格式开销 */
export function estimateInputTokens(
  messages: readonly { readonly text: string }[],
  tokensPerChar: number = DEFAULT_TOKENS_PER_CHAR,
): number {
  return messages.reduce(
    (total, message) =>
      total + MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.text, tokensPerChar),
    0,
  )
}

/**
 * 截断历史使估算输入不超过 `maxInputTokens`：从最早的消息开始丢弃，至少保留最后一条。
 * 最后一条消息本身就超过上限时抛出 `INPUT_TOO_LONG`（413）。
 */
export function truncateHistory<T extends { readonly text: string }>(
  messages: readonly T[],
  maxInputTokens: number,
  tokensPerChar: number = DEFAULT_TOKENS_PER_CHAR,
): T[] {
  const kept: T[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as T
    const tokens = MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.text, tokensPerChar)
    if (total + tokens > maxInputTokens) break
    total += tokens
    kept.unshift(message)
  }
  if (kept.length === 0 && messages.length > 0) {
    throw new AppError(INPUT_TOO_LONG, 'Message is too long for this model', { status: 413 })
  }
  return kept
}

export interface TextBudgetInput {
  /** 发起时的定价快照 */
  readonly pricing: Pricing
  /** 保守估算的输入 token 数 */
  readonly inputTokens: number
  /** 空间当前可用余额（不含已预扣部分） */
  readonly balance: number
  /** 模型 / 请求允许的最大输出 */
  readonly maxOutputTokens: number
  readonly minOutputTokens?: number
  /** `per_call` 的加权参数 */
  readonly params?: Readonly<Record<string, unknown>>
}

export interface TextBudget {
  /** 本次允许的最大输出 token 数（传给 `streamText` 的 `maxOutputTokens`） */
  readonly maxOutputTokens: number
  /** 预扣额 */
  readonly holdAmount: number
}

function insufficient(): never {
  throw new AppError(INSUFFICIENT_CREDITS, 'Insufficient credits', { status: 402 })
}

/**
 * 计算本次调用的最大输出与预扣额（specs/ai-chat「按余额限制输出长度」）：
 * - `token`：最大输出 = min(模型上限, (余额 − 输入费用) / 输出单价)，使预扣不超过余额；
 *   低于 `minOutputTokens` 时抛出 `INSUFFICIENT_CREDITS`（402）。
 * - `per_call`：预扣额固定，最大输出取 `limits.maxOutputTokens`（未配置时取模型上限）；余额不足时拒绝。
 * 预扣额一律经 `estimateCredits` 计算，与结算的取整口径一致。
 */
export function planTextBudget(input: TextBudgetInput): TextBudget {
  const { pricing, balance } = input
  const minOutput = input.minOutputTokens ?? MIN_OUTPUT_TOKENS
  switch (pricing.mode) {
    case 'per_call': {
      const holdAmount = estimateCredits(pricing, input.params ? { params: input.params } : {})
      if (holdAmount > balance) insufficient()
      return {
        maxOutputTokens: pricing.limits?.maxOutputTokens ?? input.maxOutputTokens,
        holdAmount,
      }
    }
    case 'token': {
      const cost = (maxOutputTokens: number) =>
        estimateCredits(pricing, { inputTokens: input.inputTokens, maxOutputTokens })
      if ((pricing.minCharge ?? DEFAULT_MIN_CHARGE) > balance) insufficient()
      let maxOutputTokens = input.maxOutputTokens
      if (pricing.outputPer1k > 0) {
        // 余额为整数时 ceil(x) ≤ 余额 ⇔ x ≤ 余额，下式即精确解；先乘后除减少浮点误差，
        // 再按 estimateCredits 的实际取整结果校正 ±1，保证预扣不超过余额且不少给输出
        const affordable = Math.floor(
          (balance * 1000 - input.inputTokens * pricing.inputPer1k) / pricing.outputPer1k,
        )
        maxOutputTokens = Math.max(0, Math.min(maxOutputTokens, affordable))
        while (maxOutputTokens > 0 && cost(maxOutputTokens) > balance) maxOutputTokens--
        while (maxOutputTokens < input.maxOutputTokens && cost(maxOutputTokens + 1) <= balance)
          maxOutputTokens++
      }
      if (maxOutputTokens < minOutput) insufficient()
      const holdAmount = cost(maxOutputTokens)
      // 输出单价为 0 时没有收缩，输入费用本身可能超过余额
      if (holdAmount > balance) insufficient()
      return { maxOutputTokens, holdAmount }
    }
    case 'per_unit':
      throw new AppError('MODEL_UNAVAILABLE', 'Model is not a text model', { status: 404 })
  }
}
