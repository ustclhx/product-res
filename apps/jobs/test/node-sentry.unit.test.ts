import { fileURLToPath } from 'node:url'
import { AppError } from '@product-res/shared'
import { getLogContext, withLogContext } from '@product-res/shared/log'
import type { ErrorEvent, NodeOptions } from '@sentry/node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { consumeJobsBatch, type JobsContext, runJobsSchedule } from '../src/handlers.ts'
import { initializeNodeObservability, nodeBeforeSend } from '../src/node/observability.ts'
import { handleEmailBatch } from '../src/queues/email.ts'

const spies = vi.hoisted(() => ({ loaded: vi.fn(), init: vi.fn() }))
vi.mock('@sentry/node', async (importOriginal) => {
  spies.loaded()
  const sdk = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...sdk,
    init: (...args: Parameters<typeof sdk.init>) => {
      spies.init(...args)
      return sdk.init(...args)
    },
  }
})

const config = {
  dsn: 'https://fixture@localhost/1',
  environment: 'smoke',
  release: '1234567890abcdef1234567890abcdef12345678',
} as const
const observers: Awaited<ReturnType<typeof initializeNodeObservability>>[] = []

async function fixture(reject = false) {
  const envelopes: unknown[] = []
  const events: ErrorEvent[] = []
  const transport: NodeOptions['transport'] = () => ({
    send(envelope) {
      envelopes.push(envelope)
      for (const [header, body] of envelope[1])
        if (header.type === 'event') events.push(body as ErrorEvent)
      return reject
        ? Promise.reject(new Error('transport fixture unavailable'))
        : Promise.resolve({})
    },
    flush: () => Promise.resolve(true),
  })
  const observer = await initializeNodeObservability(config, transport)
  observers.push(observer)
  return { observer, events, envelopes }
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.client?.close(100)
  vi.restoreAllMocks()
})

it('does not import or initialize the SDK or create a transport on disabled paths', async () => {
  const transport = vi.fn()
  for (const disabled of [
    { release: config.release },
    { ...config, dsn: undefined },
    { ...config, environment: 'development' as const },
    { ...config, environment: undefined },
  ]) {
    const observer = await initializeNodeObservability(disabled, transport)
    expect(observer.enabled).toBe(false)
    observer.captureException(new Error('Authorization: credential-fixture'))
    expect(observer.run(() => 'business-result')).toBe('business-result')
  }
  expect(spies.loaded).not.toHaveBeenCalled()
  expect(spies.init).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('credential-fixture')
})

it('sends isolated concurrent message identity and safe exceptions through the real SDK', async () => {
  const { observer, events, envelopes } = await fixture()
  const options = observer.client?.getOptions()
  expect(options?.integrations.map((integration) => integration.name)).toEqual([
    'NodeUncaughtException',
  ])
  expect(options?.traceLifecycle).toBe('static')
  expect(options?.beforeSendLog?.({} as never)).toBeNull()
  expect(options?.beforeSendMetric?.({} as never)).toBeNull()
  expect(options?.beforeSendTransaction?.({} as never, {})).toBeNull()
  const secrets = [
    'authorization-fixture',
    'cookie-fixture',
    'otp-fixture',
    's3-credential-fixture',
    'smtp-password-fixture',
    'mail-body-fixture',
  ]
  const sensitive = `Authorization: ${secrets[0]} Cookie: ${secrets[1]} https://s3.example/a?otp=${secrets[2]}&X-Amz-Credential=${secrets[3]} smtp://user:${secrets[4]}@host ${secrets[5]}`
  let resume!: () => void
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  const first = withLogContext(
    { requestId: 'request-a', workspaceId: 'workspace-a', userId: 'user-a', jobId: 'job-a' },
    () =>
      observer.run(async () => {
        observer.tagContext()
        await paused
        const error = new AppError('STORAGE_UNAVAILABLE', sensitive, {
          status: 503,
          cause: new Error(sensitive),
          details: { body: sensitive },
        })
        error.stack = `AppError: ${sensitive}\n    at smtp-password-fixture (${fileURLToPath(import.meta.url)}:42:7)\n    at remote (https://host/a.js?token=${secrets[2]}:1:2)\n    at remote (file://user:smtp-password-fixture@host/a.js:1:2)`
        observer.captureException(error)
        observer.captureException(error)
      }),
  )
  await withLogContext(
    { requestId: 'request-b', workspaceId: 'workspace-b', userId: 'user-b', jobId: 'job-b' },
    () =>
      observer.run(async () => {
        observer.tagContext()
        await Promise.resolve()
        observer.captureException(new Error(sensitive))
        resume()
      }),
  )
  await first
  await observer.client?.flush(1_000)
  expect(events).toHaveLength(2)
  for (const suffix of ['a', 'b']) {
    const event = events.find((candidate) => candidate.tags?.jobId === `job-${suffix}`)
    expect(event).toMatchObject({
      tags: {
        requestId: `request-${suffix}`,
        workspaceId: `workspace-${suffix}`,
        userId: `user-${suffix}`,
        jobId: `job-${suffix}`,
      },
      user: { id: `user-${suffix}` },
      release: config.release,
      environment: 'smoke',
      dist: 'jobs-node',
    })
    expect(event?.breadcrumbs).toBeUndefined()
    expect(event?.request).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain(`workspace-${suffix === 'a' ? 'b' : 'a'}`)
  }
  const firstEvent = events.find((event) => event.tags?.jobId === 'job-a')
  expect(firstEvent?.exception?.values?.[0]).toMatchObject({
    type: 'AppError',
    value: 'STORAGE_UNAVAILABLE',
    stacktrace: {
      frames: [{ filename: fileURLToPath(import.meta.url), lineno: 42, colno: 7 }],
    },
  })
  const output = JSON.stringify([envelopes, vi.mocked(console.error).mock.calls])
  for (const secret of secrets) expect(output).not.toContain(secret)
})

it('filters non-server AppErrors while retaining unexpected failures', async () => {
  const { observer, events } = await fixture()
  observer.captureException(new AppError('NOT_FOUND', 'not found', { status: 404 }))
  observer.captureException(new AppError('INTERNAL_ERROR', 'unsafe text', { status: 500 }))
  await observer.client?.flush(1_000)
  expect(events).toHaveLength(1)
  expect(events[0]?.tags?.code).toBe('INTERNAL_ERROR')
})

it('preserves email ack, retry, terminal DLQ and failed-sink behavior when transport rejects', async () => {
  const { observer, events } = await fixture(true)
  const send = vi.spyOn(globalThis, 'fetch')
  const transport = {
    transport: 'resend',
    apiKey: 'fixture-only',
    from: 'Fixture <fixture@example.com>',
    replyTo: undefined,
  } as const
  function message(id: string, attempts = 1) {
    return {
      id,
      timestamp: new Date(),
      attempts,
      body: {
        v: 1,
        template: 'reset-password',
        props: { url: 'https://app.example.com/reset?token=fixture', expiresInMinutes: 60 },
        to: 'fixture@example.com',
        appName: 'Fixture',
        idempotencyKey: id,
        requestId: `request-${id}`,
      },
      ack: vi.fn(),
      retry: vi.fn(),
    }
  }
  function batch(member: ReturnType<typeof message>) {
    return { queue: 'product-res-email', messages: [member], ackAll: vi.fn(), retryAll: vi.fn() }
  }
  send.mockResolvedValueOnce(new Response('{"id":"sent"}', { status: 200 }))
  const success = message('success')
  await handleEmailBatch(batch(success), transport, { observer })
  expect(success.ack).toHaveBeenCalledOnce()
  expect(success.retry).not.toHaveBeenCalled()

  send.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const retry = message('retry')
  await handleEmailBatch(batch(retry), transport, { observer })
  expect(retry.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
  expect(retry.ack).not.toHaveBeenCalled()

  send.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const terminal = message('terminal', 6)
  const failed = vi.fn(async () => {
    expect(terminal.ack).not.toHaveBeenCalled()
    terminal.ack()
  })
  await handleEmailBatch(batch(terminal), transport, { observer, deadLetters: { failed } })
  expect(failed).toHaveBeenCalledWith(terminal, {
    code: 'EMAIL_ATTEMPTS_EXHAUSTED',
    retryable: true,
  })
  expect(terminal.ack).toHaveBeenCalledOnce()
  expect(terminal.retry).not.toHaveBeenCalled()

  send.mockResolvedValueOnce(new Response('{}', { status: 422 }))
  const unrecorded = message('unrecorded')
  const sinkError = new Error('fixture DLQ failure')
  const failedSink = vi.fn().mockRejectedValue(sinkError)
  await expect(
    handleEmailBatch(batch(unrecorded), transport, {
      observer,
      deadLetters: { failed: failedSink },
    }),
  ).rejects.toBe(sinkError)
  expect(unrecorded.ack).not.toHaveBeenCalled()
  expect(unrecorded.retry).not.toHaveBeenCalled()
  await observer.client?.flush(1_000)
  expect(events).toHaveLength(4)
  expect(events.map((event) => event.tags?.requestId)).toEqual([
    'request-retry',
    'request-terminal',
    'request-unrecorded',
    'request-unrecorded',
  ])
  // 新增的外围持久 sink 异常保留成员身份，并移除数据库错误原文。
  expect(JSON.stringify(events)).not.toContain('fixture DLQ failure')
})

it('isolates actual consumer members and captures cron and outer sink failures with the original ALS identity', async () => {
  const { observer, events } = await fixture()
  const sdk = await import('@sentry/node')
  const parentScope = sdk.getIsolationScope()
  const scopes: unknown[] = []
  const capturedIdentity: unknown[] = []
  const sender = {
    async send() {
      scopes.push(sdk.getIsolationScope())
      capturedIdentity.push({ ...getLogContext() })
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new TypeError('SMTP password private-text')
    },
  }
  const messages = ['a', 'b'].map((id) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body: {
      v: 1,
      template: 'otp',
      to: 'fixture@example.com',
      appName: 'Fixture',
      props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 },
      idempotencyKey: id,
      requestId: `member-${id}`,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  const context = {
    observer,
    emailTransport: { transport: 'smtp' },
    emailSender: sender,
    emailDeadLetters: {
      async failed(message: (typeof messages)[number]) {
        message.ack()
      },
    },
  } as unknown as JobsContext
  await withLogContext({ jobId: 'batch-identity', workspaceId: 'workspace' }, () =>
    consumeJobsBatch(
      { queue: 'product-res-email', messages, ackAll: vi.fn(), retryAll: vi.fn() },
      context,
    ),
  )
  expect(scopes).toHaveLength(2)
  expect(scopes[0]).not.toBe(parentScope)
  expect(scopes[1]).not.toBe(scopes[0])
  expect(capturedIdentity).toEqual([
    { jobId: 'batch-identity', workspaceId: 'workspace', requestId: 'member-a' },
    { jobId: 'batch-identity', workspaceId: 'workspace', requestId: 'member-b' },
  ])
  for (const message of messages) expect(message.ack).toHaveBeenCalledOnce()
  await expect(
    withLogContext({ requestId: 'cron-request', scheduleId: 'cron-id', cron: 'invalid' }, () =>
      runJobsSchedule('invalid', new Date(), context),
    ),
  ).rejects.toThrow('Unknown cron')
  await observer.client?.flush(1_000)
  expect(events).toHaveLength(3)
  expect(events.map((event) => event.tags)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: 'member-a',
        workspaceId: 'workspace',
        jobId: 'batch-identity',
      }),
      expect.objectContaining({
        requestId: 'member-b',
        workspaceId: 'workspace',
        jobId: 'batch-identity',
      }),
      expect.objectContaining({
        requestId: 'cron-request',
        scheduleId: 'cron-id',
        cron: 'invalid',
      }),
    ]),
  )
  expect(JSON.stringify(events)).not.toContain('private-text')
})

it('retains only local source-map UUID metadata and removes unsafe debug images', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef'
  const local = fileURLToPath(import.meta.url)
  const event = nodeBeforeSend(
    {
      debug_meta: {
        images: [
          { type: 'sourcemap', code_file: local, debug_id: id, body: 'private-body' },
          {
            type: 'sourcemap',
            code_file: 'https://remote/file.js?token=private-token',
            debug_id: id,
          },
          { type: 'sourcemap', code_file: local, debug_id: 'private-credential' },
          { type: 'sourcemap', code_file: '/missing/private.js', debug_id: id },
        ],
      },
    } as never,
    { originalException: new Error('private-error') },
  )
  expect(event?.debug_meta?.images).toEqual([{ type: 'sourcemap', code_file: local, debug_id: id }])
  expect(JSON.stringify(event)).not.toMatch(
    /private-body|private-token|private-credential|private-error/,
  )
})
