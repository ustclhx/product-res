import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { nodeEnvSchema } from '@product-res/config/node'
import type { NodeJobEngine, NodeJobEngineOptions } from '@product-res/platform/node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startNodeJobs } from '../src/node/runtime.ts'

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  closeGate: undefined as Promise<void> | undefined,
  closing: undefined as Promise<void> | undefined,
  closeDb: vi.fn(),
  closeCache: vi.fn(),
  pingDb: vi.fn(),
  createCache: vi.fn(),
  createDb: vi.fn(),
  createEngine: vi.fn(),
  queueRegister: vi.fn(),
  queuePrepare: vi.fn(),
  schedulerPrepare: vi.fn(),
  dispose: vi.fn(),
  storageDelete: vi.fn(),
  jobsContext: undefined as unknown,
}))
vi.mock('@product-res/storage/node', () => ({
  createNodeStorage: () => ({ delete: fixture.storageDelete }),
}))
vi.mock('@product-res/db', () => ({
  createDb: fixture.createDb,
  pingDatabase: fixture.pingDb,
}))
// 数据层装配有独立测试；这里只验证启动与停机顺序
vi.mock('../src/datasources/node.ts', () => ({ registerNodeDataSources: vi.fn(async () => {}) }))
vi.mock('../src/selection/node.ts', () => ({ registerNodeSelection: vi.fn() }))
vi.mock('../src/review/selection-review.ts', () => ({ registerSelectionReview: vi.fn() }))
vi.mock('../src/stores/node.ts', () => ({ registerNodeStoreTracking: vi.fn() }))
vi.mock('../src/node/registration.ts', () => ({
  getNodeJobFeatures: () => ({ billing: false }),
  registerNodeJobsSchedules: (_scheduler: unknown, context: unknown) => {
    fixture.jobsContext = context
    fixture.events.push('scheduler.register')
    return fixture.dispose
  },
}))
vi.mock('@product-res/platform/node', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNodeCache: fixture.createCache,
  createNodeJobEngine: fixture.createEngine,
  createNodeQueueProducer: () => ({ producer: {} }),
  createNodeQueueAdapter: () => ({
    register: fixture.queueRegister,
    prepare: fixture.queuePrepare,
    start: () => fixture.events.push('queue.start'),
    stopReceiving: () => fixture.events.push('queue.stop'),
    health: async () => ({ status: 'up' }),
  }),
  createNodeScheduler: () => ({
    prepare: fixture.schedulerPrepare,
    start: () => fixture.events.push('scheduler.start'),
    stopReceiving: () => fixture.events.push('scheduler.stop'),
    health: async () => ({ status: 'up', lastCronAt: new Date().toISOString() }),
  }),
}))
const config = nodeEnvSchema.parse({
  DATABASE_URL: 'postgres://fixture@localhost/jobs',
  VALKEY_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'jobs-fixture-secret-at-least-32-characters',
  APP_URL: 'https://product.ezarouter.cc',
  DB_POOL_MAX: 3,
  SHUTDOWN_TIMEOUT_MS: 100,
})
const options = {
  host: '127.0.0.1',
  port: 0,
  executorId: 'jobs-fixture',
  ownershipDirectory: '/tmp/jobs-fixture-ownership',
  applicationVersion: 'build-sha',
  nativePoolMax: 3,
}
let active: Awaited<ReturnType<typeof startNodeJobs>> | undefined
beforeEach(() => {
  fixture.pingDb.mockResolvedValue(undefined)
  fixture.events.length = 0
  fixture.closeGate = undefined
  fixture.closing = undefined
  fixture.closeDb.mockImplementation(async () => {
    fixture.events.push('db.close')
  })
  fixture.closeCache.mockImplementation(async () => {
    fixture.events.push('cache.close')
  })
  fixture.dispose.mockImplementation(() => fixture.events.push('scheduler.dispose'))
  fixture.createDb.mockImplementation(() => ({ close: fixture.closeDb }))
  fixture.createCache.mockImplementation(async () => ({
    close: fixture.closeCache,
    kv: () => ({}),
    ping: async () => {},
  }))
  fixture.queueRegister.mockImplementation((name: string) => {
    fixture.events.push(`queue.register:${name}`)
  })
  fixture.queuePrepare.mockImplementation(async () => {
    fixture.events.push('queue.prepare')
  })
  fixture.schedulerPrepare.mockImplementation(async () => {
    fixture.events.push('scheduler.prepare')
  })
  fixture.createEngine.mockImplementation(async (input: NodeJobEngineOptions) => {
    let stopped = false
    const engine: NodeJobEngine = {
      database: input.database,
      executorId: input.executorId,
      ownershipToken: 'fixture-owner',
      nativePoolMax: input.nativePoolMax ?? 4,
      assertOwnership: async () => {},
      isExecutorStopped: async () => false,
      stopReceiving() {
        if (stopped) return
        stopped = true
        fixture.events.push('engine.stop')
        input.stopReceiving?.()
      },
      close() {
        engine.stopReceiving()
        fixture.closing ??= (async () => {
          fixture.events.push('engine.close.begin')
          await fixture.closeGate
          fixture.events.push('engine.close.end')
        })()
        return fixture.closing
      },
    }
    try {
      await input.register?.(engine)
      fixture.events.push('engine.launch')
      await input.start?.(engine)
      return engine
    } catch (error) {
      await engine.close()
      throw error
    }
  })
})

it('returns a versioned 503 within the probe deadline when the database query never settles', async () => {
  active = await startNodeJobs(config, options)
  fixture.pingDb.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers()
  try {
    const response = active.readiness()
    await vi.advanceTimersByTimeAsync(5_001)
    const result = await response
    expect(result.status).toBe(503)
    expect(await result.json()).toMatchObject({
      version: options.applicationVersion,
      db: { status: 'down' },
    })
  } finally {
    vi.useRealTimers()
  }
})
afterEach(async () => {
  await active?.shutdown()
  active = undefined
  vi.resetAllMocks()
})

it('prepares registered consumers before launch and drains tasks and engine before closing resources', async () => {
  active = await startNodeJobs(config, options)
  expect(fixture.events).toEqual([
    'queue.register:product-res-email',
    'queue.register:product-res-events',
    'scheduler.register',
    'queue.prepare',
    'scheduler.prepare',
    'engine.launch',
    'queue.start',
    'scheduler.start',
  ])
  expect(fixture.createEngine).toHaveBeenCalledWith(
    expect.objectContaining({
      databaseUrl: config.DATABASE_URL,
      executorId: options.executorId,
      ownershipDirectory: options.ownershipDirectory,
      applicationVersion: options.applicationVersion,
      nativePoolMax: 3,
      shutdownTimeoutMs: 100,
    }),
  )
  expect(fixture.createDb).toHaveBeenCalledWith(config.DATABASE_URL, { max: 3 })
  const port = (active.server.address() as AddressInfo).port
  const response = await fetch(`http://127.0.0.1:${port}/internal/live`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok', version: options.applicationVersion })
  const readiness = await fetch(`http://127.0.0.1:${port}/internal/ready`)
  expect(readiness.status).toBe(200)
  expect(readiness.headers.get('cache-control')).toBe('no-store')
  expect(await readiness.json()).toMatchObject({
    db: { status: 'up' },
    cache: { status: 'up' },
    queue: { status: 'up' },
    scheduler: { status: 'up' },
  })
  let finishTask!: () => void
  let finishEngine!: () => void
  active.background.waitUntil(
    new Promise<void>((resolve) => {
      finishTask = resolve
    }),
  )
  fixture.closeGate = new Promise<void>((resolve) => {
    finishEngine = resolve
  })
  const stopped = once(active.server, 'close')
  const shutdown = active.shutdown()
  expect(active.shutdown()).toBe(shutdown)
  await stopped
  expect(fixture.events.slice(-4)).toEqual([
    'engine.stop',
    'queue.stop',
    'scheduler.stop',
    'engine.close.begin',
  ])
  finishTask()
  await active.background.drain(0)
  expect(fixture.closeCache).not.toHaveBeenCalled()
  expect(fixture.closeDb).not.toHaveBeenCalled()
  finishEngine()
  expect(await shutdown).toMatchObject({ completed: true, resourcesClosed: true })
  expect(fixture.events.slice(-4)).toEqual([
    'engine.close.end',
    'scheduler.dispose',
    'cache.close',
    'db.close',
  ])
  expect(fixture.closeCache).toHaveBeenCalledOnce()
  expect(fixture.closeDb).toHaveBeenCalledOnce()
})

it('uses one shutdown deadline while retaining the business pool until engine close completes', async () => {
  active = await startNodeJobs(config, options)
  let finishEngine!: () => void
  fixture.closeGate = new Promise<void>((resolve) => {
    finishEngine = resolve
  })
  vi.useFakeTimers()
  const shutdown = active.shutdown()
  let result: Awaited<typeof shutdown> | undefined
  void shutdown.then((value) => {
    result = value
  })
  try {
    await vi.advanceTimersByTimeAsync(config.SHUTDOWN_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toMatchObject({ completed: false, pendingTasks: 1, resourcesClosed: false })
    expect(active.server.listening).toBe(false)
    expect(fixture.closeCache).not.toHaveBeenCalled()
    expect(fixture.closeDb).not.toHaveBeenCalled()
  } finally {
    finishEngine()
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  }
  await shutdown
  await vi.waitFor(() => expect(fixture.closeDb).toHaveBeenCalledOnce())
  expect(fixture.events.indexOf('db.close')).toBeGreaterThan(
    fixture.events.indexOf('engine.close.end'),
  )
})

it('closes the database when cache initialization fails', async () => {
  const failure = new Error('cache unavailable')
  fixture.createCache.mockRejectedValueOnce(failure)
  await expect(startNodeJobs(config, options)).rejects.toBe(failure)
  expect(fixture.createEngine).not.toHaveBeenCalled()
  expect(fixture.closeDb).toHaveBeenCalledOnce()
})

it('disposes registered handlers and resources when persistent preparation fails', async () => {
  const failure = new Error('schedule preparation failed')
  fixture.schedulerPrepare.mockRejectedValueOnce(failure)
  await expect(startNodeJobs(config, options)).rejects.toBe(failure)
  expect(fixture.events).not.toContain('engine.launch')
  expect(fixture.events).not.toContain('queue.start')
  expect(fixture.events.slice(-4)).toEqual([
    'engine.close.end',
    'scheduler.dispose',
    'cache.close',
    'db.close',
  ])
  expect(fixture.closeCache).toHaveBeenCalledOnce()
  expect(fixture.closeDb).toHaveBeenCalledOnce()
})

it('bridges string and array object deletion serially and preserves a cleanup failure', async () => {
  const configured = {
    ...config,
    S3_ENDPOINT: 'https://objects.example.com',
    S3_REGION: 'auto',
    S3_BUCKET: 'fixture',
    S3_FORCE_PATH_STYLE: true,
    S3_ACCESS_KEY_ID: 'fixture',
    S3_SECRET_ACCESS_KEY: 'fixture',
  }
  active = await startNodeJobs(configured, options)
  const context = fixture.jobsContext as import('../src/handlers.ts').JobsContext
  expect(context.files.available).toBe(true)
  if (!context.files.available) throw new Error('Storage not assembled')
  await context.files.value.delete('first')
  await context.files.value.delete(['second', 'third'])
  expect(fixture.storageDelete.mock.calls).toEqual([['first'], ['second'], ['third']])
  const failure = new Error('delete fixture failed')
  fixture.storageDelete.mockRejectedValueOnce(failure)
  await expect(context.files.value.delete(['failed', 'never'])).rejects.toBe(failure)
  expect(fixture.storageDelete).not.toHaveBeenCalledWith('never')
})

it('closes the injected observer after business resources with only the remaining shutdown budget', async () => {
  const close = vi.fn(async (_timeoutMs: number) => {
    fixture.events.push('observer.close')
  })
  active = await startNodeJobs(config, {
    ...options,
    observer: { tagContext() {}, captureException() {}, close },
  })
  expect(await active.shutdown()).toMatchObject({ completed: true, resourcesClosed: true })
  expect(close).toHaveBeenCalledOnce()
  expect(close.mock.calls[0]?.[0]).toBeGreaterThan(0)
  expect(close.mock.calls[0]?.[0]).toBeLessThanOrEqual(config.SHUTDOWN_TIMEOUT_MS)
  expect(fixture.events.indexOf('observer.close')).toBeGreaterThan(
    fixture.events.indexOf('db.close'),
  )
})
