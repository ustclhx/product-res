import { AppError } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import { estimateCredits, type Pricing } from '../pricing.ts'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_CHAR,
  estimateInputTokens,
  estimateTextTokens,
  INPUT_TOO_LONG,
  INSUFFICIENT_CREDITS,
  MESSAGE_OVERHEAD_TOKENS,
  MIN_OUTPUT_TOKENS,
  planTextBudget,
  textModelConfig,
  textModelConfigSchema,
  truncateHistory,
} from './budget.ts'
import { AI_PROVIDER_NOT_CONFIGURED, defaultLanguageModelFactory } from './model.ts'

const token: Pricing = { mode: 'token', inputPer1k: 2, outputPer1k: 8 }

function expectAppError(fn: () => unknown, code: string, status: number) {
  let error: unknown
  try {
    fn()
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({ code, status })
}

describe('输入 token 保守估算', () => {
  it('按码点计字符数乘以系数，向上取整', () => {
    expect(estimateTextTokens('hello')).toBe(5 * DEFAULT_TOKENS_PER_CHAR)
    expect(estimateTextTokens('你好👋')).toBe(3)
    expect(estimateTextTokens('abc', 1.5)).toBe(5)
    expect(estimateTextTokens('')).toBe(0)
  })

  it('不低于常见分词器的实际 token 数（英文约 4 字符 / token，中文约 1 字 / token）', () => {
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const chinese = '今天天气很好，我们一起去公园散步吧。'.repeat(20)
    expect(estimateTextTokens(english)).toBeGreaterThanOrEqual(english.length / 4)
    expect(estimateTextTokens(chinese)).toBeGreaterThanOrEqual([...chinese].length)
  })

  it('多条消息累加，每条加格式开销', () => {
    expect(estimateInputTokens([{ text: 'ab' }, { text: 'cde' }])).toBe(
      2 + 3 + 2 * MESSAGE_OVERHEAD_TOKENS,
    )
    expect(estimateInputTokens([{ text: 'ab' }], 2)).toBe(4 + MESSAGE_OVERHEAD_TOKENS)
  })

  it('系数与输出上限可按模型配置（params_schema 的 x-text），缺失或不合法时取默认值', () => {
    expect(
      textModelConfig({
        paramsSchema: { 'x-text': { tokensPerChar: 1.5, maxOutputTokens: 8000 } },
      }),
    ).toEqual({
      tokensPerChar: 1.5,
      maxOutputTokens: 8000,
      thinking: undefined,
      continuation: 'none',
    })
    const defaults = {
      tokensPerChar: DEFAULT_TOKENS_PER_CHAR,
      maxOutputTokens: 4096,
      thinking: undefined,
      continuation: 'none',
    }
    expect(textModelConfig({ paramsSchema: null })).toEqual(defaults)
    expect(textModelConfig({ paramsSchema: { 'x-text': { tokensPerChar: -1 } } })).toEqual(defaults)
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096)
  })

  it('按模型声明 thinking 与原生续写能力，严格拒绝非法能力与未知键', () => {
    expect(
      textModelConfig({ paramsSchema: { 'x-text': { thinking: true, continuation: 'native' } } }),
    ).toMatchObject({ thinking: true, continuation: 'native' })
    expect(textModelConfigSchema.safeParse({ thinking: false, continuation: 'none' }).success).toBe(
      true,
    )
    expect(textModelConfig({ paramsSchema: { 'x-text': {} } }).thinking).toBeUndefined()
    expect(textModelConfig({ paramsSchema: { 'x-text': { thinking: false } } }).thinking).toBe(
      false,
    )
    for (const config of [
      { thinking: 'true' },
      { thinking: null },
      { continuation: 'prompt' },
      { continuation: true },
      { thinking: true, unknown: true },
    ]) {
      expect(textModelConfigSchema.safeParse(config).success).toBe(false)
      expect(textModelConfig({ paramsSchema: { 'x-text': config } })).toMatchObject({
        thinking: undefined,
        continuation: 'none',
      })
    }
  })

  it('按上限截断历史：丢弃最早的消息，至少保留最后一条', () => {
    const messages = [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(50) }, { text: 'c'.repeat(10) }]
    const limit = 50 + 10 + 2 * MESSAGE_OVERHEAD_TOKENS
    expect(truncateHistory(messages, limit)).toEqual(messages.slice(1))
    expect(truncateHistory(messages, limit - 1)).toEqual(messages.slice(2))
    expect(truncateHistory(messages, 10_000)).toEqual(messages)
    expectAppError(() => truncateHistory(messages, 5), INPUT_TOO_LONG, 413)
  })
})

describe('按余额计算最大输出长度（token 计费）', () => {
  it('余额只够约 1000 个输出 token、模型上限 8000 时，上限被压到约 1000', () => {
    // 输入 500 token = 1 积分；余额 9 → 剩 8 积分 = 1000 个输出 token
    const budget = planTextBudget({
      pricing: token,
      inputTokens: 500,
      balance: 9,
      maxOutputTokens: 8000,
    })
    expect(budget.maxOutputTokens).toBe(1000)
    expect(budget.holdAmount).toBe(9)
  })

  it('余额充足时取模型上限，预扣额按上限计算', () => {
    const budget = planTextBudget({
      pricing: token,
      inputTokens: 500,
      balance: 10_000,
      maxOutputTokens: 8000,
    })
    expect(budget).toEqual({
      maxOutputTokens: 8000,
      holdAmount: estimateCredits(token, { inputTokens: 500, maxOutputTokens: 8000 }),
    })
  })

  it('不能整除时向下取整，预扣不超过余额', () => {
    const pricing: Pricing = { mode: 'token', inputPer1k: 0.3, outputPer1k: 0.7 }
    for (const balance of [1, 2, 3, 7, 10, 33]) {
      const budget = planTextBudget({ pricing, inputTokens: 1234, balance, maxOutputTokens: 1e6 })
      expect(budget.holdAmount).toBeLessThanOrEqual(balance)
      // 再多 1 个输出 token 就会超过余额
      expect(
        estimateCredits(pricing, {
          inputTokens: 1234,
          maxOutputTokens: budget.maxOutputTokens + 1,
        }),
      ).toBeGreaterThan(balance)
    }
  })

  it('不足最小输出时报余额不足', () => {
    // 剩 2 积分 = 250 个输出 token < 256
    expectAppError(
      () => planTextBudget({ pricing: token, inputTokens: 500, balance: 3, maxOutputTokens: 8000 }),
      INSUFFICIENT_CREDITS,
      402,
    )
    // 输入费用已超过余额
    expectAppError(
      () =>
        planTextBudget({ pricing: token, inputTokens: 10_000, balance: 5, maxOutputTokens: 8000 }),
      INSUFFICIENT_CREDITS,
      402,
    )
    // 恰好够最小输出时接受：476 个输入 token = 0.952 积分，256 个输出 token = 2.048 积分
    expect(
      planTextBudget({ pricing: token, inputTokens: 476, balance: 3, maxOutputTokens: 8000 }),
    ).toEqual({ maxOutputTokens: MIN_OUTPUT_TOKENS, holdAmount: 3 })
  })

  it('最低费用高于余额时报余额不足', () => {
    const pricing: Pricing = { mode: 'token', inputPer1k: 0, outputPer1k: 0, minCharge: 5 }
    expectAppError(
      () => planTextBudget({ pricing, inputTokens: 10, balance: 4, maxOutputTokens: 8000 }),
      INSUFFICIENT_CREDITS,
      402,
    )
    expect(planTextBudget({ pricing, inputTokens: 10, balance: 5, maxOutputTokens: 8000 })).toEqual(
      { maxOutputTokens: 8000, holdAmount: 5 },
    )
  })
})

describe('按次计费的预算', () => {
  const perCall: Pricing = {
    mode: 'per_call',
    credits: 3,
    multipliers: { quality: { high: 2 } },
    limits: { maxInputTokens: 4000, maxOutputTokens: 1000 },
  }

  it('预扣固定积分（按参数加权），最大输出取 limits', () => {
    expect(
      planTextBudget({ pricing: perCall, inputTokens: 100, balance: 3, maxOutputTokens: 8000 }),
    ).toEqual({ maxOutputTokens: 1000, holdAmount: 3 })
    expect(
      planTextBudget({
        pricing: perCall,
        inputTokens: 100,
        balance: 6,
        maxOutputTokens: 8000,
        params: { quality: 'high' },
      }).holdAmount,
    ).toBe(6)
  })

  it('余额不足以支付固定积分时拒绝', () => {
    expectAppError(
      () =>
        planTextBudget({ pricing: perCall, inputTokens: 100, balance: 2, maxOutputTokens: 8000 }),
      INSUFFICIENT_CREDITS,
      402,
    )
  })
})

describe('默认模型工厂', () => {
  it('Gateway 缺少配置时抛出 503 AI_PROVIDER_NOT_CONFIGURED', () => {
    const model = {
      id: 'm',
      key: 'gpt',
      kind: 'text' as const,
      provider: 'openai',
      providerModelId: 'gpt',
      pricing: token,
      tags: [],
      paramsSchema: null,
      sort: 0,
    }
    expectAppError(() => defaultLanguageModelFactory(model, {}), AI_PROVIDER_NOT_CONFIGURED, 503)
  })
})
