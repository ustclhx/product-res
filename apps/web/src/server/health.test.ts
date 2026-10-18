import { type Database, pingDatabase, readLastCronAt } from '@product-res/db'
import type { QueueHealth, SchedulerHealth, TaskHealth } from '@product-res/platform'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { healthResponse } from './health.ts'

vi.mock('@product-res/db', () => ({
  pingDatabase: vi.fn(),
  readLastCronAt: vi.fn(),
}))
vi.mock('@product-res/shared/log', () => ({ log: { error: vi.fn() } }))

const now = Date.parse('2026-10-13T12:00:00.000Z')
const lastCronAt = '2026-10-13T11:55:00.000Z'

beforeEach(() => {
  vi.mocked(pingDatabase).mockReset().mockResolvedValue(undefined)
  vi.mocked(readLastCronAt).mockReset().mockResolvedValue(lastCronAt)
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => vi.restoreAllMocks())

it.each([200, 503])('%s 响应原样返回构建提交标识', async (status) => {
  if (status === 503) vi.mocked(pingDatabase).mockRejectedValue(new Error('unavailable'))
  const version = 'abcdef0123456789abcdef0123456789abcdef0123'
  const response = await healthResponse({
    database: () => ({}) as Database,
    version,
  })
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ version })
})

it('数据库初始化失败也返回脱敏 503 与版本', async () => {
  const response = await healthResponse({
    database: () => {
      throw new Error('postgres://private-host:secret')
    },
    version: 'build-sha',
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    status: 'error',
    version: 'build-sha',
    db: { status: 'down' },
  })
})

function nodeDependencies() {
  const cache = vi.fn(async () => {})
  const queue = vi.fn<() => Promise<QueueHealth>>(async () => ({ status: 'up' }))
  const scheduler = vi.fn<() => Promise<SchedulerHealth>>(async () => ({
    status: 'up',
    lastCronAt,
  }))
  return { cache, tasks: { queue, scheduler } satisfies TaskHealth }
}

it('Node 所有依赖正常时无缓存返回调度器的真实成功心跳', async () => {
  const dependencies = nodeDependencies()
  // 数据库 probe 中的旧读数不能代替调度器的成功心跳。
  vi.mocked(readLastCronAt).mockResolvedValue('2026-10-12T00:00:00.000Z')
  const response = await healthResponse({
    database: () => ({}) as Database,
    version: 'node-build-sha',
    dependencies,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({
    status: 'ok',
    version: 'node-build-sha',
    db: { status: 'up', latencyMs: expect.any(Number) },
    cache: { status: 'up' },
    queue: { status: 'up' },
    scheduler: { status: 'up', lastCronAt },
    jobs: { lastCronAt },
  })
})

it.each([
  'database',
  'cache',
  'queue backend',
  'queue consumer',
  'queue unavailable',
  'scheduler',
  'scheduler unavailable',
] as const)('Node %s 故障时返回脱敏 503 并保留其他探测结果', async (dependency) => {
  const dependencies = nodeDependencies()
  const failure = new Error('private-host:secret')
  const expected: Record<string, unknown> = {
    status: 'error',
    version: 'node-build-sha',
    db: { status: 'up', latencyMs: expect.any(Number) },
    cache: { status: 'up' },
    queue: { status: 'up' },
    scheduler: { status: 'up', lastCronAt },
    jobs: { lastCronAt },
  }
  if (dependency === 'database') {
    vi.mocked(pingDatabase).mockRejectedValue(failure)
    expected.db = { status: 'down' }
  } else if (dependency === 'cache') {
    dependencies.cache.mockRejectedValue(failure)
    expected.cache = { status: 'down' }
  } else if (dependency === 'queue backend') {
    dependencies.tasks.queue.mockRejectedValue(failure)
    expected.queue = { status: 'down' }
  } else if (dependency === 'queue consumer') {
    dependencies.tasks.queue.mockResolvedValue({ status: 'down' })
    expected.queue = { status: 'down' }
  } else if (dependency === 'queue unavailable') {
    dependencies.tasks.queue.mockResolvedValue({ status: 'unavailable' })
    expected.queue = { status: 'unavailable' }
  } else {
    const status = dependency === 'scheduler' ? 'down' : 'unavailable'
    dependencies.tasks.scheduler.mockResolvedValue({ status, lastCronAt })
    expected.scheduler = { status, lastCronAt }
  }
  const response = await healthResponse({
    database: () => ({}) as Database,
    version: 'node-build-sha',
    dependencies,
  })
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(expected)
})

it.each(['2026-10-13T11:49:59.999Z', null])(
  'Node 心跳陈旧或缺失（%s）时返回旧值而不以存活时间冒充成功',
  async (heartbeat) => {
    const dependencies = nodeDependencies()
    dependencies.tasks.scheduler.mockResolvedValue({ status: 'up', lastCronAt: heartbeat })
    const response = await healthResponse({
      database: () => ({}) as Database,
      version: 'node-build-sha',
      dependencies,
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      status: 'error',
      scheduler: { status: 'up', lastCronAt: heartbeat },
      jobs: { lastCronAt: heartbeat },
    })
  },
)

it('Node 卡住的消费者探测在超时后降为 down，仍返回其余依赖状态', async () => {
  const dependencies = nodeDependencies()
  dependencies.tasks.queue.mockImplementation(() => new Promise(() => {}))
  const response = await healthResponse({
    database: () => ({}) as Database,
    version: 'node-build-sha',
    dependencies,
    timeoutMs: 5,
  })
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({
    status: 'error',
    db: { status: 'up' },
    cache: { status: 'up' },
    queue: { status: 'down' },
    scheduler: { status: 'up', lastCronAt },
  })
})
