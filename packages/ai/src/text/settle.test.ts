import { type CreditsTransaction, capture, release } from '@product-res/credits'
import { type AiUsageCheckpoint, type Database, scoped } from '@product-res/db'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pricing } from '../pricing.ts'
import {
  checkpointSchedule,
  interruptedCredits,
  messageText,
  settleChatMessage,
  settleFromCheckpoint,
  settleInterruptedChatMessage,
} from './settle.ts'

vi.mock('@product-res/credits', async (original) => ({
  ...(await original<typeof import('@product-res/credits')>()),
  capture: vi.fn(),
  release: vi.fn(),
}))
vi.mock('@product-res/db', async (original) => ({
  ...(await original<typeof import('@product-res/db')>()),
  scoped: vi.fn(),
}))

describe('checkpointSchedule（tasks 2.5）', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('每 200 个输出 token 到期一次', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    expect(schedule.due(199)).toBe(false)
    expect(schedule.due(200)).toBe(true)
    expect(schedule.due(399)).toBe(false)
    expect(schedule.due(400)).toBe(true)
  })

  it('每 5 秒到期一次，但没有新输出时不到期', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    c.advance(4_999)
    expect(schedule.due(10)).toBe(false)
    c.advance(1)
    expect(schedule.due(10)).toBe(true)
    c.advance(10_000)
    expect(schedule.due(10)).toBe(false)
    expect(schedule.due(11)).toBe(true)
  })

  it('先到者触发，并从触发时重新计时与计数', () => {
    const c = clock()
    const schedule = checkpointSchedule({ now: c.now })
    c.advance(1_000)
    expect(schedule.due(250)).toBe(true)
    c.advance(4_500)
    // 距上次 4.5 秒、新增 100 token：都未到
    expect(schedule.due(350)).toBe(false)
    c.advance(500)
    expect(schedule.due(360)).toBe(true)
  })
})

describe('interruptedCredits（tasks 2.4、2.6）', () => {
  const token: Pricing = { mode: 'token', inputPer1k: 1, outputPer1k: 10, minCharge: 2 }
  const perCall: Pricing = {
    mode: 'per_call',
    credits: 3,
    limits: { maxInputTokens: 1000, maxOutputTokens: 500 },
  }

  it('按 token：按已产生用量结算', () => {
    // (1000 × 1 + 1000 × 10) / 1000 = 11
    expect(
      interruptedCredits(token, { inputTokens: 1000, outputTokens: 1000, hasOutput: true }),
    ).toBe(11)
  })

  it('按 token：没有输出用量时收最低费用（按估算输入，不低于 minCharge）', () => {
    expect(interruptedCredits(token, { inputTokens: 100, outputTokens: 0, hasOutput: false })).toBe(
      2,
    )
    expect(
      interruptedCredits(token, { inputTokens: 5000, outputTokens: 0, hasOutput: false }),
    ).toBe(5)
  })

  it('按次（默认 any_output）：有输出全额，无输出释放', () => {
    const usage = { inputTokens: 10, outputTokens: 0 }
    expect(interruptedCredits(perCall, { ...usage, hasOutput: true })).toBe(3)
    expect(interruptedCredits(perCall, { ...usage, hasOutput: false })).toBeUndefined()
  })

  it('按次 chargeOn success：未完成一律释放', () => {
    expect(
      interruptedCredits(
        { ...perCall, chargeOn: 'success' },
        { inputTokens: 10, outputTokens: 10, hasOutput: true },
      ),
    ).toBeUndefined()
  })
})

it('messageText 只拼接文本 part', () => {
  expect(
    messageText([
      { type: 'text', text: 'a' },
      { type: 'image' },
      null,
      { type: 'text', text: 'b' },
    ]),
  ).toBe('ab')
})

describe('reasoning 失败结算与回收', () => {
  const token: Pricing = { mode: 'token', inputPer1k: 1, outputPer1k: 10, minCharge: 2 }
  const perCall: Pricing = {
    mode: 'per_call',
    credits: 3,
    limits: { maxInputTokens: 1000, maxOutputTokens: 1000 },
  }
  const tx = {} as CreditsTransaction
  const db = {
    transaction: (run: (tx: CreditsTransaction) => Promise<unknown>) => run(tx),
  } as Database
  const update = vi.fn()
  const base = {
    workspaceId: 'ws',
    messageId: 'msg',
    holdId: 'hold',
    inputTokens: 1000,
    outputTokens: 1000,
    reasoningTokens: 800,
    absorbed: { inputTokens: 100, outputTokens: 200, reasoningTokens: 200 },
    usageSource: 'actual' as const,
    overage: { maxRatio: 0, maxCredits: 0, dailyBudgetPerWorkspace: 0 },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(scoped).mockReturnValue({
      select: () => ({ limit: async () => [{ amount: 5 }] }),
      updateById: update,
    } as unknown as ReturnType<typeof scoped>)
    vi.mocked(capture).mockImplementation(async (_db, input) => ({
      captured: input.actualAmount,
      absorbed: 0,
      debited: 0,
      debt: 0,
    }))
  })

  for (const pricing of [token, perCall]) {
    for (const failedReplyRefund of ['no-visible-output', 'all'] as const) {
      it(`${pricing.mode} / ${failedReplyRefund}：完成只按输出总量计费，不重复加入 reasoning 或 absorbed`, async () => {
        await settleChatMessage(db, {
          ...base,
          pricing,
          failedReplyRefund,
          text: '正文',
          reasoning: '思考',
        })
        const amount = pricing.mode === 'token' ? 11 : 3
        expect(capture).toHaveBeenCalledWith(tx, expect.objectContaining({ actualAmount: amount }))
        expect(release).not.toHaveBeenCalled()
        const persistedUsage = JSON.parse(
          new PgDialect().sqlToQuery(update.mock.calls[0]?.[2].usageCheckpoint).params[0] as string,
        )
        expect(persistedUsage).toMatchObject({
          inputTokens: 1000,
          outputTokens: 1000,
          reasoningTokens: 800,
          absorbed: base.absorbed,
          failedReplyRefund,
        })
        expect(update).toHaveBeenCalledWith(
          expect.anything(),
          'msg',
          expect.objectContaining({
            credits: amount,
            outputTokens: 1000,
            parts: [
              { type: 'reasoning', text: '思考' },
              { type: 'text', text: '正文' },
            ],
          }),
        )
      })
      for (const hasOutput of [false, true]) {
        it(`${pricing.mode} / ${failedReplyRefund} / 正文=${hasOutput}：失败收费与退款守恒`, async () => {
          const settlement = await settleInterruptedChatMessage(db, {
            ...base,
            pricing,
            failedReplyRefund,
            status: 'failed',
            hasOutput,
            text: hasOutput ? '正文' : '',
          })
          const amount =
            hasOutput && failedReplyRefund !== 'all' ? (pricing.mode === 'token' ? 5 : 3) : 0
          expect(settlement).toEqual({ captured: amount, absorbed: 0, debited: 0, debt: 0 })
          if (amount)
            expect(capture).toHaveBeenCalledWith(
              tx,
              expect.objectContaining({ actualAmount: amount }),
              tx,
            )
          else {
            expect(capture).not.toHaveBeenCalled()
            expect(release).toHaveBeenCalledWith(tx, { workspaceId: 'ws', holdId: 'hold' }, tx)
          }
          expect(update).toHaveBeenCalledWith(
            expect.anything(),
            'msg',
            expect.objectContaining({
              status: 'failed',
              credits: amount,
              inputTokens: 1000,
              outputTokens: 1000,
            }),
          )
          // capture <= hold，capture + release = hold；不会产生补扣、欠费。
          expect(5 - amount + (settlement?.captured ?? 0)).toBe(5)
        })
      }
    }
  }

  it.each([
    null,
    { inputTokens: 1000, outputTokens: 800, reasoningTokens: 800, at: '2026-10-14T00:00:00Z' },
  ])('回收无检查点或仅 reasoning 无正文时全额释放', async (usageCheckpoint) => {
    await settleFromCheckpoint(
      db,
      {
        id: 'msg',
        workspaceId: 'ws',
        holdId: 'hold',
        pricing: token,
        inputTokens: 1000,
        parts: [{ type: 'reasoning', text: '思考' }],
        usageCheckpoint,
      },
      { status: 'failed', overage: base.overage },
    )
    expect(capture).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('主动停止即使拿到完整 usage 也不超出原预扣', async () => {
    await settleInterruptedChatMessage(db, {
      ...base,
      pricing: token,
      status: 'aborted',
      hasOutput: true,
      text: '正文',
    })
    expect(capture).toHaveBeenCalledWith(tx, expect.objectContaining({ actualAmount: 5 }), tx)
  })

  it('跨 isolate 在 reasoning 阶段停止按次回复，与本地停止一样全退', async () => {
    await settleFromCheckpoint(
      db,
      {
        id: 'msg',
        workspaceId: 'ws',
        holdId: 'hold',
        pricing: perCall,
        inputTokens: 10,
        parts: [],
        usageCheckpoint: {
          inputTokens: 10,
          outputTokens: 200,
          reasoningTokens: 200,
          at: '2026-10-14T00:00:00Z',
        },
      },
      { status: 'aborted', overage: base.overage },
    )
    expect(capture).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('回收遵循已持久化的失败全退策略，主动停止仍收费', async () => {
    const message = {
      id: 'msg',
      workspaceId: 'ws',
      holdId: 'hold',
      pricing: perCall,
      inputTokens: 1000,
      parts: [{ type: 'text', text: '正文' }],
      usageCheckpoint: {
        inputTokens: 1000,
        outputTokens: 800,
        reasoningTokens: 700,
        failedReplyRefund: 'all',
        at: '2026-10-14T00:00:00Z',
      } satisfies AiUsageCheckpoint,
    }
    await settleFromCheckpoint(db, message, { status: 'failed', overage: base.overage })
    expect(release).toHaveBeenCalledOnce()
    await settleFromCheckpoint(db, message, { status: 'aborted', overage: base.overage })
    expect(capture).toHaveBeenCalledWith(tx, expect.objectContaining({ actualAmount: 3 }), tx)
  })
})
