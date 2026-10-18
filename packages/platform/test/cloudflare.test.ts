import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test'
import type { WorkflowStep as CloudflareStep } from 'cloudflare:workers'
import { NonRetryableError as CloudflareNonRetryableError } from 'cloudflare:workflows'
import { describe, expect, it, vi } from 'vitest'
import {
  cloudflareTransactionalEnqueue,
  createCloudflareBackgroundTasks,
  createCloudflareKv,
  createCloudflareQueue,
  createCloudflareQueueBatch,
  createCloudflareRateLimiter,
  createCloudflareRequestMetadata,
  createCloudflareScheduler,
  createCloudflareWorkflow,
  createCloudflareWorkflowStep,
} from '../src/cloudflare/index.ts'
import { NonRetryableError, requireCapability } from '../src/index.ts'

describe('Cloudflare capability adapters', () => {
  it('preserves queue delivery ids, per-message retry/ack and producer delays', async () => {
    const batch = createMessageBatch('email', [
      { id: 'ack-id', timestamp: new Date(), body: { kind: 'ack' }, attempts: 1 },
      { id: 'retry-id', timestamp: new Date(), body: { kind: 'retry' }, attempts: 3 },
    ])
    const adapted = createCloudflareQueueBatch(batch)
    expect(adapted.messages).toBe(batch.messages)
    adapted.messages[0]?.ack()
    adapted.messages[1]?.retry({ delaySeconds: 120 })
    const result = await getQueueResult(batch, createExecutionContext())
    expect(result.explicitAcks).toEqual(['ack-id'])
    expect(result.retryMessages).toEqual([{ msgId: 'retry-id' }])
    const binding = {
      send: vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })),
      sendBatch: vi.fn(async () => ({
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      })),
    }
    const producer = createCloudflareQueue(binding)
    await producer.send({ kind: 'one' }, { delaySeconds: 30 })
    const messages = [{ body: { kind: 'two' }, delaySeconds: 60 }]
    await producer.sendBatch(messages)
    expect(binding.send).toHaveBeenCalledWith({ kind: 'one' }, { delaySeconds: 30 })
    expect(binding.sendBatch).toHaveBeenCalledWith(messages)
    expect(cloudflareTransactionalEnqueue().available).toBe(false)
  })

  it('normalizes workflow state and surfaces missing instances and terminal events', async () => {
    let state: InstanceStatus = { status: 'complete', output: { taskId: 'task' } }
    const sendEvent = vi.fn(async () => {})
    const instance = {
      id: 'task',
      status: async () => state,
      sendEvent,
      terminate: vi.fn(async () => {}),
    } as unknown as WorkflowInstance
    const binding = { create: vi.fn(async () => instance), get: vi.fn(async () => instance) }
    const workflow = createCloudflareWorkflow(binding)
    const handle = await workflow.create({ id: 'task', params: { taskId: 'task' } })
    expect(binding.create).toHaveBeenCalledWith({ id: 'task', params: { taskId: 'task' } })
    expect(await handle.status()).toEqual({ status: 'completed', output: { taskId: 'task' } })
    await expect(handle.sendEvent({ type: 'media-done', payload: null })).rejects.toMatchObject({
      code: 'WORKFLOW_TERMINAL',
    })
    expect(sendEvent).not.toHaveBeenCalled()
    state = { status: 'errored', error: { name: 'Error', message: 'failed' } }
    expect((await handle.status()).status).toBe('failed')
    state = { status: 'waiting' }
    await handle.sendEvent({ type: 'media-done', payload: { ready: true } })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'media-done', payload: { ready: true } })
    state = { status: 'unknown' }
    await expect(workflow.get('missing')).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' })
  })

  it('treats terminate of an instance that already finished as done, and rethrows otherwise', async () => {
    let state: InstanceStatus = { status: 'running' }
    const raced = new Error(
      'WorkflowError: (instance.cannot_terminate) Cannot terminate instance since its on a finite state',
    )
    const instance = {
      id: 'task',
      status: async () => state,
      sendEvent: vi.fn(),
      terminate: vi.fn(async () => {
        throw raced
      }),
    } as unknown as WorkflowInstance
    const handle = await createCloudflareWorkflow({
      create: vi.fn(),
      get: vi.fn(async () => instance),
    }).get('task')
    // 调用方读到 running 后实例自行结束，terminate 才抛错
    state = { status: 'complete' }
    await expect(handle.terminate()).resolves.toBeUndefined()
    state = { status: 'running' }
    await expect(handle.terminate()).rejects.toBe(raced)
  })

  it('converts step retry/timeout milliseconds and the shared non-retryable signal', async () => {
    const doStep = vi.fn(
      async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) =>
        (typeof configOrCallback === 'function'
          ? configOrCallback
          : (callback as () => Promise<unknown>))(),
    )
    const sleep = vi.fn(async () => {})
    const event = { type: 'media-done', timestamp: new Date(), payload: { ready: true } }
    const waitForEvent = vi.fn(async () => event)
    const step = createCloudflareWorkflowStep({
      do: doStep,
      sleep,
      waitForEvent,
    } as unknown as CloudflareStep)
    expect(
      await step.do(
        'submit',
        { retries: { limit: 3, delayMs: 10_000, backoff: 'exponential' }, timeoutMs: 120_000 },
        async () => ({ jobId: 'job' }),
      ),
    ).toEqual({ jobId: 'job' })
    expect(doStep).toHaveBeenCalledWith(
      'submit',
      { retries: { limit: 3, delay: 10_000, backoff: 'exponential' }, timeout: 120_000 },
      expect.any(Function),
    )
    await step.sleep('poll', 30_000)
    expect(sleep).toHaveBeenCalledWith('poll', 30_000)
    expect(await step.waitForEvent('result', { type: 'media-done', timeoutMs: 900_000 })).toEqual(
      event,
    )
    expect(waitForEvent).toHaveBeenCalledWith('result', { type: 'media-done', timeout: 900_000 })
    const failure = step.do('fail', async () => {
      throw new NonRetryableError('stop')
    })
    await expect(failure).rejects.toMatchObject({ name: 'NonRetryableError', message: 'stop' })
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('restores the shared non-retryable error and its code after the engine copies the rejection', async () => {
    // 模拟 CF 引擎：回调异常经 RPC 复制后只剩 name/message，再由 do() 拒绝。
    const engineErrors: unknown[] = []
    const copy = (error: unknown) => {
      engineErrors.push(error)
      const { name, message } = error as Error
      return Object.assign(new Error(message), { name })
    }
    const step = createCloudflareWorkflowStep({
      async do(_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) {
        try {
          return await (callback ?? (configOrCallback as () => Promise<unknown>))()
        } catch (error) {
          throw copy(error)
        }
      },
    } as unknown as CloudflareStep)
    const failure = step.do('submit', { retries: { limit: 2, delayMs: 10_000 } }, async () => {
      throw Object.assign(
        new NonRetryableError('Workers AI image generation failed (AiError 8007)'),
        { code: 'WORKERS_AI_GENERATION_FAILED' },
      )
    })
    const error = await failure.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NonRetryableError)
    expect(error).toMatchObject({
      code: 'WORKERS_AI_GENERATION_FAILED',
      message: 'Workers AI image generation failed (AiError 8007)',
    })
    // 引擎仍收到原生不可重试信号；其 rejection 作为 cause 供观测按 do 关联。
    expect(engineErrors[0]).toBeInstanceOf(CloudflareNonRetryableError)
    expect(engineErrors[0]).not.toHaveProperty('code')
    expect((error as Error).cause).toMatchObject({ name: 'NonRetryableError' })
    expect((error as Error).cause).not.toBeInstanceOf(NonRetryableError)

    // 重放时引擎直接拒绝而不执行回调：无原错误可还原，原样传播。
    const replayed = new Error('replayed engine failure')
    const replay = createCloudflareWorkflowStep({
      do: async () => {
        throw replayed
      },
    } as unknown as CloudflareStep)
    await expect(replay.do('submit', async () => null)).rejects.toBe(replayed)
  })

  it('keeps deployed UTC cron time and runs independent handlers even if one fails', async () => {
    const scheduler = createCloudflareScheduler({
      crons: ['0 4 * * *'],
      health: async () => ({ status: 'up', lastCronAt: '2026-10-12T04:00:00.000Z' }),
    })
    const definition = {
      id: 'first',
      cron: '0 4 * * *',
      timeZone: 'UTC',
      missedRun: 'skip',
    } as const
    scheduler.register(definition, async () => {
      throw new Error('maintenance failed')
    })
    const independent = vi.fn(async () => {})
    scheduler.register({ ...definition, id: 'second' }, independent)
    const at = Date.parse('2026-10-12T04:00:00.000Z')
    await expect(scheduler.scheduled({ cron: definition.cron, scheduledTime: at })).rejects.toThrow(
      AggregateError,
    )
    expect(independent).toHaveBeenCalledWith({ scheduledAt: new Date(at) })
    expect(() =>
      scheduler.register(
        { ...definition, id: 'unsupported', timeZone: 'Asia/Taipei' },
        independent,
      ),
    ).toThrow(expect.objectContaining({ code: 'SCHEDULE_UNSUPPORTED' }))
    expect(() =>
      scheduler.register({ ...definition, id: 'catch-up', missedRun: 'once' }, independent),
    ).toThrow(expect.objectContaining({ code: 'SCHEDULE_UNSUPPORTED' }))
    expect(await scheduler.health()).toEqual({
      status: 'up',
      lastCronAt: '2026-10-12T04:00:00.000Z',
    })
  })

  it('uses native KV text/JSON and preserves its minimum TTL', async () => {
    const kv = createCloudflareKv(env.CACHE as KVNamespace)
    await kv.put('platform-json', JSON.stringify({ enabled: true }), { expirationTtl: 1 })
    expect(await kv.get<{ enabled: boolean }>('platform-json', 'json')).toEqual({ enabled: true })
    expect(await kv.get('platform-json')).toBe('{"enabled":true}')
    await kv.delete('platform-json')
    expect(await kv.get('platform-json')).toBeNull()
  })

  it('routes policy bindings and lifecycle calls through the current request context', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const limiter = createCloudflareRateLimiter({ RL_AI: { limit } })
    expect(await limiter.limit('ai', 'workspace:one')).toEqual({ success: false })
    expect(limit).toHaveBeenCalledWith({ key: 'workspace:one' })
    expect(() => limiter.limit('auth', 'ip')).toThrow(expect.objectContaining({ status: 503 }))
    const waitUntil = vi.fn()
    const promise = Promise.resolve()
    createCloudflareBackgroundTasks({ waitUntil }).waitUntil(promise)
    expect(waitUntil).toHaveBeenCalledWith(promise)
    const request = new Request('https://example.test', {
      headers: { 'cf-connecting-ip': '203.0.113.1', 'cf-ray': 'diagnostic' },
    })
    const meta = createCloudflareRequestMetadata(request)
    expect(meta.clientIp).toBe('203.0.113.1')
    expect(meta.cfRay).toBe('diagnostic')
    expect(createCloudflareRequestMetadata(request).requestId).not.toBe(meta.requestId)
    expect(() =>
      requireCapability(cloudflareTransactionalEnqueue(), 'transactional enqueue'),
    ).toThrow(expect.objectContaining({ status: 503 }))
  })
})
