import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTemplateConfig } from '@product-res/config'
import { nodeEnvSchema } from '@product-res/config/node'
import { createDb, jobDeadLetter, jobMessage, jobSchedule, jobScheduleRun } from '@product-res/db'
import { RESEND_API_URL } from '@product-res/email'
import type { EmailQueueMessage } from '@product-res/email/queue'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { startNodeJobs } from '../src/node/runtime.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Node jobs condition timed out')
    await sleep(100)
  }
}

it('wires real consumers, retry/DLQ, disabled modules, heartbeat readiness and graceful stop', async () => {
  const databaseUrl = process.env.TEST_JOB_DATABASE_URL
  const valkeyUrl = process.env.TEST_VALKEY_URL
  if (!databaseUrl || !valkeyUrl) throw new Error('Isolated PG and Valkey required')
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-wire-'))
  const db = createDb(databaseUrl, { max: 3 })
  const config = nodeEnvSchema.parse({
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
    BETTER_AUTH_SECRET: 'jobs-wire-fixture-at-least-32-characters',
    APP_URL: 'https://product.ezarouter.cc',
    EMAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: 'fixture',
    EMAIL_FROM: 'fixture@example.com',
    SHUTDOWN_TIMEOUT_MS: 5000,
  })
  const template = defineTemplateConfig({
    app: {
      name: 'Fixture',
      url: 'https://product.ezarouter.cc',
      supportEmail: 'hxl15380@gmail.com',
    },
    billing: { enabled: false },
    credits: { enabled: false },
    ai: { text: { enabled: false }, image: false, video: false },
  })
  const attempts = new Map<string, number>()
  const originalFetch = globalThis.fetch
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== RESEND_API_URL) return originalFetch(input, init)
    const key = new Headers(init?.headers).get('idempotency-key') as string
    const count = (attempts.get(key) ?? 0) + 1
    attempts.set(key, count)
    return key === 'permanent' || key === 'exhausted'
      ? Response.json({ name: 'validation_error' }, { status: key === 'permanent' ? 400 : 503 })
      : key === 'retry' && count === 1
        ? Response.json({ name: 'internal_server_error' }, { status: 503 })
        : Response.json({ id: key })
  })
  let runtime: Awaited<ReturnType<typeof startNodeJobs>> | undefined
  try {
    runtime = await startNodeJobs(config, {
      host: '127.0.0.1',
      port: 0,
      executorId: `wire-${newId()}`,
      ownershipDirectory: directory,
      applicationVersion: 'wire-integration-v1',
      template,
    })
    const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`
    expect((await originalFetch(`${base}/internal/live`)).status).toBe(200)
    // Queue 与 scheduler 独立轮询；两者首次成功后才能断言只因缺少心跳而未就绪。
    await until(async () => {
      const [queue, scheduler] = await Promise.all([
        runtime?.tasks.health.queue(),
        runtime?.tasks.health.scheduler(),
      ])
      return queue?.status === 'up' && scheduler?.status === 'up'
    })
    const initial = await originalFetch(`${base}/internal/ready`)
    expect(initial.status).toBe(503)
    expect(await initial.json()).toMatchObject({
      queue: { status: 'up' },
      scheduler: { status: 'up', lastCronAt: null },
    })
    expect((await db.select().from(jobSchedule)).map((row) => [row.cron, row.timeZone])).toEqual(
      expect.arrayContaining([
        ['*/5 * * * *', 'UTC'],
        ['*/10 * * * *', 'UTC'],
        ['0 3 * * *', 'UTC'],
      ]),
    )
    expect(
      (await db.select().from(jobSchedule)).filter((row) => row.id.startsWith('jobs-billing-')),
    ).toEqual([])
    const producer = (
      await import('@product-res/platform/node')
    ).createNodeQueueProducer<EmailQueueMessage>(db, 'product-res-email').producer
    const message = (key: string): EmailQueueMessage => ({
      v: 1,
      template: 'otp',
      props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 },
      to: 'fixture@example.com',
      appName: 'Fixture',
      idempotencyKey: key,
      requestId: 'wire-request',
    })
    await producer.sendBatch([
      ...Array.from({ length: 9 }, (_, i) => ({ body: message(`success-${i}`) })),
      { body: message('retry') },
    ])
    await until(
      async () =>
        (await db.select().from(jobMessage)).filter((row) => row.state === 'acked').length === 10,
      50_000,
    )
    expect(attempts.get('retry')).toBe(2)
    for (let i = 0; i < 9; i++) expect(attempts.get(`success-${i}`)).toBe(1)
    await producer.send(message('permanent'))
    await producer.send(message('exhausted'), { delaySeconds: 60 })
    const [exhausted] = await db
      .select()
      .from(jobMessage)
      .where(eq(jobMessage.idempotencyKey, 'exhausted'))
    if (!exhausted) throw new Error('Missing test message')
    // 从已耗尽第五次的状态验证业务第六次失败的hook；完整生产退避时钟由B引擎验收覆盖。
    await db
      .update(jobMessage)
      .set({ attempts: 5, availableAt: new Date() })
      .where(eq(jobMessage.id, exhausted.id))
    const events = (await import('@product-res/platform/node')).createNodeQueueProducer(
      db,
      'product-res-events',
    ).producer
    await events.send({ v: 1, deliveryId: newId(), requestId: 'wire-disabled' })
    await until(async () => (await db.select().from(jobDeadLetter)).length === 3)
    expect((await db.select().from(jobDeadLetter)).map((row) => row.code)).toEqual(
      expect.arrayContaining([
        'EMAIL_NON_RETRYABLE',
        'EMAIL_ATTEMPTS_EXHAUSTED',
        'BILLING_DISABLED',
      ]),
    )
    expect((await db.select().from(jobMessage)).filter((row) => row.state === 'dead')).toHaveLength(
      3,
    )
    // 实际等待下一个UTC五分钟slot，不回填心跳或修改数据库时钟。
    await until(async () => {
      const runs = await db.select().from(jobScheduleRun)
      return (
        runs.some((run) => run.scheduleId === 'jobs-heartbeat-v1' && run.state === 'completed') &&
        (await originalFetch(`${base}/internal/ready`)).status === 200
      )
    }, 310_000)
    const ready = await originalFetch(`${base}/internal/ready`)
    expect(await ready.json()).toMatchObject({
      status: 'ok',
      version: 'wire-integration-v1',
      db: { status: 'up' },
      cache: { status: 'up' },
      queue: { status: 'up' },
      scheduler: { status: 'up' },
      jobs: { lastCronAt: expect.any(String) },
    })
    runtime.scheduler.stopReceiving()
    expect((await originalFetch(`${base}/internal/ready`)).status).toBe(503)
    runtime.queues.stopReceiving()
    expect((await runtime.tasks.health.queue()).status).toBe('down')
    expect(await runtime.shutdown()).toMatchObject({ completed: true, resourcesClosed: true })
    runtime = undefined
  } finally {
    await runtime?.shutdown()
    mock.mockRestore()
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 380_000)
