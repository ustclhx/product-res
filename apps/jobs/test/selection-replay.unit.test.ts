import type { DeadLetterSink, QueueBatch, QueueMessage } from '@product-res/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runReplayStep = vi.fn()
let failStep = false
vi.mock('@product-res/follow', async (original) => ({
  ...(await original<typeof import('@product-res/follow')>()),
  runReplayStep: async (...args: unknown[]) => {
    if (failStep) throw new Error('db down')
    return runReplayStep(...args)
  },
}))

const { consumeReplay } = await import('../src/selection/replay.ts')

const now = new Date('2031-09-01T00:00:00Z')

function message(body: unknown, attempts = 1) {
  return {
    id: 'm1',
    body,
    attempts,
    timestamp: now,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies QueueMessage<unknown>
}

function run(msg: ReturnType<typeof message>, registry = { get: () => ({ id: 'keepa' }) }) {
  const sink = { failed: vi.fn(async () => {}) } satisfies DeadLetterSink<unknown>
  const batch = {
    queue: 'q',
    messages: [msg],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as QueueBatch<unknown>
  return {
    sink,
    done: consumeReplay(
      batch,
      { db: {} as never, registry: registry as never, secret: () => 'k', now: () => now },
      sink,
    ),
  }
}

const body = { v: 1, replayId: 'r1', workspaceId: 'w1' }

describe('Keepa 回放队列消费者', () => {
  beforeEach(() => {
    runReplayStep.mockReset()
    failStep = false
  })

  it('额度不足：按额度恢复时刻延迟重投，不确认', async () => {
    runReplayStep.mockResolvedValue({
      status: 'deferred',
      retryAt: new Date(now.getTime() + 42_000),
      reason: 'BUDGET_HARD_CAP',
    })
    const msg = message(body)
    await run(msg).done
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 42 })
    expect(msg.ack).not.toHaveBeenCalled()
  })

  it('完成或失败（如没有凭据）都确认消息；无效消息直接确认', async () => {
    runReplayStep.mockResolvedValueOnce({ status: 'failed', code: 'KEEPA_API_KEY_MISSING' })
    const failed = message(body)
    await run(failed).done
    expect(failed.ack).toHaveBeenCalled()
    const invalid = message({ nope: true })
    await run(invalid).done
    expect(invalid.ack).toHaveBeenCalled()
    expect(runReplayStep).toHaveBeenCalledTimes(1)
  })

  it('异常重试，超过上限进入死信', async () => {
    failStep = true
    const first = message(body, 1)
    await run(first).done
    expect(first.retry).toHaveBeenCalledWith()
    const last = message(body, 6)
    const { sink, done } = run(last)
    await done
    expect(sink.failed).toHaveBeenCalledWith(last, { code: 'REPLAY_INTERNAL', retryable: true })
    expect(last.ack).toHaveBeenCalled()
  })
})
