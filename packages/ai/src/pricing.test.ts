import { describe, expect, it } from 'vitest'
import {
  actualCredits,
  estimateCredits,
  type Pricing,
  PricingError,
  parsePricing,
} from './pricing.ts'

function expectPricingError(fn: () => unknown, code: PricingError['code']) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PricingError)
    expect((error as PricingError).code).toBe(code)
    return
  }
  expect.fail(`expected PricingError ${code}`)
}

const textPerCall = {
  mode: 'per_call',
  credits: 1,
  limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
} as const

describe('parsePricing', () => {
  it('accepts each pricing mode', () => {
    expect(parsePricing(textPerCall, 'text')).toEqual(textPerCall)
    const token = { mode: 'token', inputPer1k: 2, outputPer1k: 8, minCharge: 2 }
    expect(parsePricing(token, 'text')).toEqual(token)
    const perUnit = {
      mode: 'per_unit',
      unit: 'second',
      perUnit: 20,
      multipliers: { fps: { '30': 2 } },
    }
    expect(parsePricing(perUnit, 'video')).toEqual(perUnit)
  })

  it('rejects per_call text models without both token limits', () => {
    expectPricingError(
      () => parsePricing({ mode: 'per_call', credits: 1 }, 'text'),
      'MISSING_TOKEN_LIMITS',
    )
    expectPricingError(
      () =>
        parsePricing({ mode: 'per_call', credits: 1, limits: { maxInputTokens: 8000 } }, 'text'),
      'MISSING_TOKEN_LIMITS',
    )
  })

  it('does not require token limits for per_call media models', () => {
    const video = { mode: 'per_call', credits: 5, multipliers: { resolution: { '1080p': 2 } } }
    expect(parsePricing(video, 'video')).toEqual(video)
  })

  it.each([
    ['unknown mode', { mode: 'free' }],
    ['non-positive credits', { mode: 'per_call', credits: 0 }],
    ['negative token price', { mode: 'token', inputPer1k: -1, outputPer1k: 8 }],
    ['fractional minCharge', { mode: 'token', inputPer1k: 2, outputPer1k: 8, minCharge: 0.5 }],
    ['unknown unit', { mode: 'per_unit', unit: 'minute', perUnit: 1 }],
    [
      'zero multiplier',
      { mode: 'per_unit', unit: 'image', perUnit: 10, multipliers: { size: { s: 0 } } },
    ],
    ['unknown field', { mode: 'token', inputPer1k: 2, outputPer1k: 8, outputPer1K: 8 }],
    ['not an object', 'token'],
  ])('rejects %s', (_, input) => {
    expectPricingError(() => parsePricing(input, 'image'), 'INVALID_PRICING')
  })
})

describe('per_call', () => {
  const video: Pricing = {
    mode: 'per_call',
    credits: 5,
    multipliers: { resolution: { '720p': 1, '1080p': 2 } },
  }

  it('charges the fixed credits weighted by multipliers, settling at the held amount', () => {
    const params = { resolution: '1080p' }
    expect(estimateCredits(video, { params })).toBe(10)
    expect(actualCredits(video, { params })).toBe(10)
    expect(estimateCredits(video, { params: { resolution: '720p' } })).toBe(5)
  })

  it('multiplies several weighted params and rounds up', () => {
    const pricing: Pricing = {
      mode: 'per_call',
      credits: 3,
      multipliers: { resolution: { '1080p': 2 }, duration: { '10': 1.5 } },
    }
    expect(estimateCredits(pricing, { params: { resolution: '1080p', duration: 10 } })).toBe(9)
    expect(estimateCredits(pricing, { params: { duration: '10' } })).toBe(5)
  })

  it('treats omitted params as ×1 and rejects values missing from the table', () => {
    expect(estimateCredits(video, {})).toBe(5)
    expectPricingError(
      () => estimateCredits(video, { params: { resolution: '4k' } }),
      'UNKNOWN_MULTIPLIER_VALUE',
    )
  })
})

describe('token', () => {
  const chat: Pricing = { mode: 'token', inputPer1k: 2, outputPer1k: 8 }

  it('estimates from estimated input and max output, settles from actual usage', () => {
    expect(estimateCredits(chat, { inputTokens: 1500, maxOutputTokens: 1000 })).toBe(11)
    expect(actualCredits(chat, { inputTokens: 1500, outputTokens: 400 })).toBe(7) // 3 + 3.2
  })

  it('rounds the combined cost up once and never settles above the estimate', () => {
    const cheap: Pricing = { mode: 'token', inputPer1k: 0.1, outputPer1k: 0.2 }
    expect(actualCredits(cheap, { inputTokens: 1000, outputTokens: 1000 })).toBe(1) // 0.1 + 0.2, no float drift
    expect(actualCredits(cheap, { inputTokens: 10_000, outputTokens: 10_001 })).toBe(4)
    const estimate = estimateCredits(chat, { inputTokens: 1234, maxOutputTokens: 777 })
    for (const outputTokens of [0, 1, 500, 777]) {
      expect(actualCredits(chat, { inputTokens: 1234, outputTokens })).toBeLessThanOrEqual(estimate)
    }
  })

  it('charges at least minCharge, defaulting to 1', () => {
    expect(actualCredits(chat, { inputTokens: 0, outputTokens: 0 })).toBe(1)
    expect(actualCredits({ ...chat, minCharge: 3 }, { inputTokens: 10, outputTokens: 10 })).toBe(3)
  })

  it('requires non-negative integer token counts', () => {
    expectPricingError(() => estimateCredits(chat, { inputTokens: 100 }), 'INVALID_USAGE')
    expectPricingError(
      () => actualCredits(chat, { inputTokens: -1, outputTokens: 0 }),
      'INVALID_USAGE',
    )
    expectPricingError(
      () => actualCredits(chat, { inputTokens: 1.5, outputTokens: 0 }),
      'INVALID_USAGE',
    )
  })
})

describe('per_unit', () => {
  const image: Pricing = {
    mode: 'per_unit',
    unit: 'image',
    perUnit: 10,
    multipliers: { size: { sm: 1, lg: 1.5 } },
  }
  const video: Pricing = { mode: 'per_unit', unit: 'second', perUnit: 20 }

  it('estimates from requested units and settles from reported units, weighted by multipliers', () => {
    expect(estimateCredits(image, { units: 4, params: { size: 'lg' } })).toBe(60)
    expect(actualCredits(image, { units: 3, params: { size: 'lg' } })).toBe(45)
    expect(actualCredits(video, { units: 5.01 })).toBe(101)
  })

  it('requires a non-negative unit count', () => {
    expectPricingError(() => estimateCredits(video, {}), 'INVALID_USAGE')
    expectPricingError(() => actualCredits(video, { units: -1 }), 'INVALID_USAGE')
  })
})

it('rejects amounts beyond the credit ledger range', () => {
  const pricing: Pricing = { mode: 'per_unit', unit: 'second', perUnit: 1_000_000 }
  expectPricingError(() => estimateCredits(pricing, { units: 1_000_000 }), 'CREDITS_OUT_OF_RANGE')
})
