import { ConnectorError, createMockConnector, createRegistry } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runSyncTask = vi.fn()
vi.mock('@product-res/marketdata', async (original) => ({
  ...(await original<typeof import('@product-res/marketdata')>()),
  runSyncTask: (...args: unknown[]) => runSyncTask(...args),
}))

const { consumeDataSync, DATASYNC_MAX_RETRIES } = await import('../src/datasources/sync.ts')

function message(body: unknown, attempts = 1) {
  const state = { acked: false, retried: false }
  const msg: QueueMessage<unknown> = {
    id: 'm1',
    body,
    attempts,
    timestamp: new Date(),
    ack: () => {
      state.acked = true
    },
    retry: () => {
      state.retried = true
    },
  }
  return { msg, state }
}

const batch = (...messages: QueueMessage<unknown>[]): QueueBatch<unknown> => ({
  queue: 'product-res-datasync',
  messages,
  ackAll: () => {},
  retryAll: () => {},
})

const validBody = {
  sourceId: 'mock',
  task: { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids: ['1'] } },
  mode: 'scheduled',
  trigger: 'scheduled',
}

describe('数据同步队列消费者', () => {
  const failed = vi.fn(async () => {})
  const context = {
    db: {} as Database,
    registry: createRegistry([createMockConnector()]),
    secret: () => undefined,
  }
  beforeEach(() => {
    runSyncTask.mockReset()
    failed.mockClear()
  })

  it('无效消息直接确认，不执行同步', async () => {
    const { msg, state } = message({ nope: true })
    await consumeDataSync(batch(msg), context, { failed })
    expect(state.acked).toBe(true)
    expect(runSyncTask).not.toHaveBeenCalled()
  })

  it('未知数据源进入死信后确认', async () => {
    const { msg, state } = message({ ...validBody, sourceId: 'unknown' })
    await consumeDataSync(batch(msg), context, { failed })
    expect(failed).toHaveBeenCalledWith(msg, { code: 'UNKNOWN_SOURCE', retryable: false })
    expect(state.acked).toBe(true)
  })

  it('可重试失败按队列重试，耗尽后进入死信', async () => {
    const error = new ConnectorError('retryable', 'HTTP_503')
    runSyncTask.mockResolvedValue({ status: 'failed', runId: 'r', error })
    const first = message(validBody, 1)
    await consumeDataSync(batch(first.msg), context, { failed })
    expect(first.state).toEqual({ acked: false, retried: true })
    const last = message(validBody, DATASYNC_MAX_RETRIES + 1)
    await consumeDataSync(batch(last.msg), context, { failed })
    expect(failed).toHaveBeenCalledWith(last.msg, { code: 'HTTP_503', retryable: true })
    expect(last.state.acked).toBe(true)
  })

  it('额度不足（deferred）与永久错误直接确认', async () => {
    runSyncTask.mockResolvedValueOnce({
      status: 'deferred',
      runId: 'r',
      reason: 'safety-line',
      resetsAt: new Date(),
    })
    const deferred = message(validBody)
    await consumeDataSync(batch(deferred.msg), context, { failed })
    expect(deferred.state).toEqual({ acked: true, retried: false })
    runSyncTask.mockResolvedValueOnce({
      status: 'failed',
      runId: 'r',
      error: new ConnectorError('auth', 'HTTP_401'),
    })
    const auth = message(validBody)
    await consumeDataSync(batch(auth.msg), context, { failed })
    expect(auth.state).toEqual({ acked: true, retried: false })
    expect(failed).not.toHaveBeenCalled()
  })

  it('分钟周期额度不足时等到下一分钟重试，不丢掉当天任务', async () => {
    const mock = createMockConnector()
    const minute = { ...mock, id: 'minute', budget: { ...mock.budget, period: 'minute' as const } }
    const now = new Date('2031-06-02T02:30:20Z')
    const minuteContext = {
      ...context,
      registry: createRegistry([minute]),
      now: () => now,
    }
    runSyncTask.mockResolvedValueOnce({
      status: 'deferred',
      runId: 'r',
      reason: 'safety-line',
      resetsAt: new Date('2031-06-02T02:31:00Z'),
    })
    const retried: unknown[] = []
    const { msg, state } = message({ ...validBody, sourceId: 'minute' })
    const withDelay = { ...msg, retry: (options?: unknown) => retried.push(options) }
    await consumeDataSync(batch(withDelay), minuteContext, { failed })
    expect(state.acked).toBe(false)
    expect(retried).toEqual([{ delaySeconds: 41 }])
  })
})
