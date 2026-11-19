import { MESSAGE_OVERHEAD_TOKENS } from '@product-res/ai'
import { describe, expect, it } from 'vitest'
import { BudgetLedger, estimateCall, requirePrice, settledUsd, usdFor } from './budget.ts'
import { EvalConfigError } from './errors.ts'

const model = {
  provider: 'openai',
  providerModelId: 'm',
  priceUsd: { inputPerMTok: 1_000, outputPerMTok: 2_000 },
}

describe('预算估算', () => {
  it('按输入估算 + 最大输出乘以单价', () => {
    const estimate = estimateCall(model, ['abcd', '你好'], 10)
    expect(estimate.inputTokens).toBe(6 + 2 * MESSAGE_OVERHEAD_TOKENS)
    expect(estimate.usd).toBeCloseTo(usdFor(model.priceUsd, 22, 10))
    expect(estimateCall({ ...model, tokensPerChar: 2 }, ['ab'], 0).inputTokens).toBe(4 + 8)
  })

  it('缺单价或预算不合法为配置错误', () => {
    expect(() => requirePrice('m', { provider: 'x', providerModelId: 'y' })).toThrow(
      EvalConfigError,
    )
    expect(() => new BudgetLedger(0)).toThrow(EvalConfigError)
    expect(() => new BudgetLedger(Number.NaN)).toThrow(EvalConfigError)
  })
})

describe('预算账本', () => {
  it('调用前触顶：上限 0.10、已花费 0.08、下一次估算 0.03 时不发出，之后一律拒绝', () => {
    const ledger = new BudgetLedger(0.1)
    const first = ledger.reserve(0.08)
    expect(first).not.toBeNull()
    ledger.settle(first as NonNullable<typeof first>, 0.08)
    expect(ledger.reserve(0.03)).toBeNull()
    expect(ledger.exhausted).toBe(true)
    expect(ledger.reserve(0.001)).toBeNull()
    expect(ledger.spent).toBeCloseTo(0.08)
  })

  it('生成在预算内完成后，评委调用估算超额时不发出，生成费用保留', () => {
    const ledger = new BudgetLedger(0.05)
    const generation = ledger.reserve(0.03)
    ledger.settle(generation as NonNullable<typeof generation>, 0.02)
    expect(ledger.reserve(0.04)).toBeNull()
    expect(ledger.spent).toBeCloseTo(0.02)
  })

  it('用量缺失时按调用前的估算值记账', () => {
    const estimate = estimateCall(model, ['abc'], 50)
    expect(settledUsd(model.priceUsd, estimate, undefined)).toBeCloseTo(estimate.usd)
    expect(settledUsd(model.priceUsd, estimate, { inputTokens: 5 })).toBeCloseTo(
      usdFor(model.priceUsd, 5, 50),
    )
    expect(settledUsd(model.priceUsd, estimate, { inputTokens: 5, outputTokens: 7 })).toBeCloseTo(
      usdFor(model.priceUsd, 5, 7),
    )
  })

  it('并发 4 时先预留再调用，已花费与在途之和始终不超过上限', async () => {
    const ledger = new BudgetLedger(1)
    let peak = 0
    let started = 0
    let skipped = 0
    const delays = [5, 1, 8, 3, 6, 2, 7, 4, 9, 1, 5, 3, 2, 8, 6, 4]
    let next = 0
    const worker = async () => {
      while (next < delays.length) {
        const delay = delays[next++] as number
        const reservation = ledger.reserve(0.15)
        if (!reservation) {
          skipped++
          continue
        }
        started++
        peak = Math.max(peak, ledger.spent + ledger.reserved)
        await new Promise((resolve) => setTimeout(resolve, delay))
        // 实际用量略低于估算
        ledger.settle(reservation, 0.1)
        peak = Math.max(peak, ledger.spent + ledger.reserved)
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    expect(peak).toBeLessThanOrEqual(1)
    expect(started).toBeGreaterThan(0)
    expect(skipped).toBeGreaterThan(0)
    expect(started + skipped).toBe(delays.length)
    expect(ledger.reserved).toBeCloseTo(0)
  })
})
