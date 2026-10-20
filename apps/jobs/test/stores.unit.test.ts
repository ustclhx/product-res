import { createRegistry } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type {
  DeadLetterSink,
  QueueBatch,
  ScheduleDefinition,
  ScheduledHandler,
  Scheduler,
} from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'

// add-accuracy-store-tracking 3.3：店铺追踪的定时计划可暂停，手动一轮走队列、不受暂停影响。
const rounds: unknown[] = []
vi.mock('../src/stores/round.ts', async (original) => ({
  ...(await original<typeof import('../src/stores/round.ts')>()),
  runStoreTrackingRound: async (_context: unknown, options: unknown) => {
    rounds.push(options)
    return {}
  },
}))

const { registerNodeStoreTracking, consumeStoreRounds, STORE_ROUND_MAX_RETRIES } = await import(
  '../src/stores/node.ts'
)
const { pausePipelineSchedules, PAUSABLE_PIPELINE_SCHEDULES } = await import(
  '../src/pipeline-pause.ts'
)

const dataSync = { db: {} as Database, registry: createRegistry([]), secret: () => undefined }

function setup(paused: boolean) {
  const handlers = new Map<string, ScheduledHandler>()
  const definitions = new Map<string, ScheduleDefinition>()
  const scheduler = {
    register: (definition: ScheduleDefinition, handler: ScheduledHandler) => {
      definitions.set(definition.id, definition)
      handlers.set(definition.id, handler)
    },
    health: async () => ({ healthy: true }),
  } as unknown as Scheduler
  const queues = { register: vi.fn() }
  registerNodeStoreTracking({
    scheduler: pausePipelineSchedules(scheduler, paused),
    queues,
    dataSync,
  })
  return { handlers, definitions, queues }
}

function message(body: unknown, attempts = 1) {
  return { id: 'm1', body, attempts, ack: vi.fn(), retry: vi.fn() }
}

const sink = { failed: vi.fn(async () => {}) } as unknown as DeadLetterSink<unknown>

afterEach(() => {
  rounds.length = 0
  vi.restoreAllMocks()
})

describe('店铺追踪调度', () => {
  it('每日 03:00 SGT，属于可暂停计划；暂停时到点直接返回', async () => {
    expect(PAUSABLE_PIPELINE_SCHEDULES.has('store-tracking-daily-v1')).toBe(true)
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const { handlers, definitions, queues } = setup(true)
    expect(definitions.get('store-tracking-daily-v1')).toMatchObject({
      cron: '0 3 * * *',
      timeZone: 'Asia/Singapore',
      missedRun: 'once',
    })
    await handlers.get('store-tracking-daily-v1')?.({ scheduledAt: new Date() })
    expect(info).toHaveBeenCalledWith('pipeline.paused', { scheduleId: 'store-tracking-daily-v1' })
    expect(rounds).toEqual([])
    // 手动触发队列照常注册，串行消费
    expect(queues.register).toHaveBeenCalledWith(
      'product-res-store-tracking',
      expect.any(Function),
      { concurrency: 1 },
    )
  })

  it('未暂停时到点运行一轮（全部空间）', async () => {
    const { handlers } = setup(false)
    const scheduledAt = new Date('2031-06-01T19:00:00Z')
    await handlers.get('store-tracking-daily-v1')?.({ scheduledAt })
    expect(rounds).toEqual([{ scheduledAt }])
  })

  it('手动一轮只处理发起的空间并忽略周期；无效消息确认丢弃', async () => {
    const ok = message({
      v: 1,
      type: 'store-tracking-round',
      workspaceId: 'ws-1',
      requestedAt: '2031-06-01T00:00:00Z',
      idempotencyKey: 'k',
    })
    const bad = message({ v: 1, type: 'other' })
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    await consumeStoreRounds(
      { messages: [ok, bad] } as unknown as QueueBatch<unknown>,
      dataSync,
      sink,
    )
    expect(rounds).toEqual([
      expect.objectContaining({ workspaceId: 'ws-1', manual: true, requestId: 'm1' }),
    ])
    expect(ok.ack).toHaveBeenCalled()
    expect(bad.ack).toHaveBeenCalled()
  })

  it('一轮出错时重试，超过次数进入死信', async () => {
    const roundModule = await import('../src/stores/round.ts')
    vi.spyOn(log, 'error').mockImplementation(() => {})
    const failing = { ...dataSync, now: () => new Date() }
    // 模拟数据库等基础设施错误
    const spy = vi
      .spyOn(roundModule, 'runStoreTrackingRound')
      .mockRejectedValue(new Error('db down'))
    const body = {
      v: 1,
      type: 'store-tracking-round',
      workspaceId: 'ws-1',
      requestedAt: '2031-06-01T00:00:00Z',
      idempotencyKey: 'k',
    }
    const first = message(body, 1)
    const last = message(body, STORE_ROUND_MAX_RETRIES + 1)
    await consumeStoreRounds(
      { messages: [first, last] } as unknown as QueueBatch<unknown>,
      failing,
      sink,
    )
    expect(spy).toHaveBeenCalledTimes(2)
    expect(first.retry).toHaveBeenCalled()
    expect(last.ack).toHaveBeenCalled()
    expect(sink.failed).toHaveBeenCalledWith(last, { code: 'STORE_ROUND_FAILED', retryable: true })
  })
})
