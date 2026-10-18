import { createDb, setting, webhookEvent } from '@product-res/db'
import { eq, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { processWebhook, replayWebhook, type WebhookTransaction } from './pipeline.ts'
import type { NormalizedEvent, PaymentProvider, VerifiedWebhook } from './provider.ts'

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env
const url = env.BILLING_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: url })
const prefix = `pipeline-${crypto.randomUUID()}`
let sequence = 0
function input(eventsCount = 1) {
  const id = `${prefix}-${sequence++}`
  const payload = { id, type: 'test.delivery', resource: { retained: true } }
  const events: NormalizedEvent[] = Array.from({ length: eventsCount }, (_, i) => ({
    type: 'payment.disputed',
    provider: 'stripe',
    occurredAt: new Date(),
    raw: payload,
    providerPaymentId: `${id}-${i}`,
    providerDisputeId: `${id}-${i}`,
    amount: 100,
    currency: 'USD',
  }))
  const normalized: VerifiedWebhook = { providerEventId: id, type: payload.type, events }
  const provider = {
    id: 'stripe',
    verifyWebhook: vi.fn(async () => normalized),
  } as unknown as PaymentProvider
  return {
    db,
    provider,
    request: new Request('https://example.test/webhook'),
    rawBody: JSON.stringify(payload),
    normalized,
    handler: effect,
  }
}
async function effect(tx: WebhookTransaction, event: NormalizedEvent) {
  if (event.type !== 'payment.disputed') throw new Error('Unexpected test event')
  await tx.insert(setting).values({ key: event.providerDisputeId, value: { applied: true } })
}
async function row(id: string) {
  const [result] = await db.select().from(webhookEvent).where(eq(webhookEvent.providerEventId, id))
  if (!result) throw new Error('Missing test delivery')
  return result
}
async function effects() {
  return db
    .select()
    .from(setting)
    .where(like(setting.key, `${prefix}%`))
}
function gate() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  await db.delete(setting).where(like(setting.key, `${prefix}%`))
  await db.delete(webhookEvent).where(like(webhookEvent.providerEventId, `${prefix}%`))
})
afterAll(() => db.$client.end())

describe('webhook pipeline on PostgreSQL', () => {
  it('verifies before accessing the database and rejects provider mismatch', async () => {
    const opts = input()
    vi.mocked(opts.provider.verifyWebhook).mockRejectedValueOnce(new Error('Bad signature'))
    await expect(processWebhook(opts)).rejects.toThrow('Bad signature')
    expect(
      await db
        .select()
        .from(webhookEvent)
        .where(eq(webhookEvent.providerEventId, opts.normalized.providerEventId)),
    ).toEqual([])
    const event = opts.normalized.events[0]
    if (!event) throw new Error('Missing test event')
    event.provider = 'paypal'
    await expect(processWebhook(opts)).rejects.toThrow('provider mismatch')
    expect(await effects()).toEqual([])
  })

  it('sequential and concurrent duplicate deliveries apply every effect exactly once', async () => {
    const opts = input(2)
    const results = await Promise.all([
      processWebhook(opts),
      processWebhook(opts),
      processWebhook(opts),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['duplicate', 'duplicate', 'processed'])
    expect((await processWebhook(opts)).status).toBe('duplicate')
    expect(await effects()).toHaveLength(2)
    expect((await row(opts.normalized.providerEventId)).attempts).toBe(1)
  })

  it('acknowledges Stripe redeliveries when only pending_webhooks changes and rejects changed business data', async () => {
    const opts = input()
    const originalPayload = { ...JSON.parse(opts.rawBody), pending_webhooks: 3 }
    opts.rawBody = JSON.stringify(originalPayload)
    for (const event of opts.normalized.events) event.raw = originalPayload
    const prepare = vi.fn()
    const notify = vi.fn()
    expect((await processWebhook({ ...opts, prepare, notify })).status).toBe('processed')
    const stored = await row(opts.normalized.providerEventId)

    const redelivery = { ...originalPayload, pending_webhooks: 1 }
    opts.rawBody = JSON.stringify(redelivery)
    for (const event of opts.normalized.events) event.raw = redelivery
    expect((await processWebhook({ ...opts, prepare, notify })).status).toBe('duplicate')
    expect(await row(opts.normalized.providerEventId)).toEqual(stored)
    expect(await effects()).toHaveLength(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)

    const substituted = { ...redelivery, resource: { retained: false } }
    opts.rawBody = JSON.stringify(substituted)
    for (const event of opts.normalized.events) event.raw = substituted
    await expect(processWebhook(opts)).rejects.toThrow('association mismatch')
    expect(await row(opts.normalized.providerEventId)).toEqual(stored)
  })

  it('retries failed Stripe deliveries when pending_webhooks changes without replacing the stored payload', async () => {
    const opts = input()
    const originalPayload = { ...JSON.parse(opts.rawBody), pending_webhooks: 3 }
    opts.rawBody = JSON.stringify(originalPayload)
    for (const event of opts.normalized.events) event.raw = originalPayload
    expect(
      (
        await processWebhook({
          ...opts,
          handler: async () => {
            throw new Error('temporary')
          },
        })
      ).status,
    ).toBe('failed')

    const redelivery = { ...originalPayload, pending_webhooks: 1 }
    opts.rawBody = JSON.stringify(redelivery)
    for (const event of opts.normalized.events) event.raw = redelivery
    expect((await processWebhook(opts)).status).toBe('processed')
    expect(await row(opts.normalized.providerEventId)).toMatchObject({
      payload: originalPayload,
      status: 'processed',
      attempts: 2,
    })
    expect(await effects()).toHaveLength(1)
  })

  it('rolls back all multi-event effects, persists a bounded error, and retries successfully', async () => {
    const opts = input(2)
    let calls = 0
    const notify = vi.fn()
    const failed = await processWebhook({
      ...opts,
      notify,
      handler: async (tx, event) => {
        await effect(tx, event)
        if (++calls === 2) throw new Error(`secret=hidden\n${'x'.repeat(700)}`)
      },
    })
    expect(failed.status).toBe('failed')
    expect(await effects()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    const stored = await row(opts.normalized.providerEventId)
    expect(stored.status).toBe('failed')
    expect(stored.payload).toEqual(JSON.parse(opts.rawBody))
    expect(stored.attempts).toBe(1)
    expect(stored.error).toHaveLength(500)
    expect(stored.error).not.toContain('hidden')
    expect((await processWebhook(opts)).status).toBe('processed')
    expect(await effects()).toHaveLength(2)
    expect((await row(opts.normalized.providerEventId)).attempts).toBe(2)
  })

  it('normalizes trusted replay outside the transaction and refuses identity/provider substitution', async () => {
    const opts = input()
    await processWebhook({
      ...opts,
      handler: async () => {
        throw new Error('temporary')
      },
    })
    const stored = await row(opts.normalized.providerEventId)
    const replay = {
      db,
      webhookEventId: stored.id,
      providerId: 'stripe' as const,
      handler: effect,
      normalize: async (payload: unknown) => {
        expect(payload).toEqual(stored.payload)
        return opts.normalized
      },
    }
    await expect(
      replayWebhook({
        ...replay,
        normalize: async () => ({ ...opts.normalized, providerEventId: 'another' }),
      }),
    ).rejects.toThrow('association mismatch')
    await expect(replayWebhook({ ...replay, providerId: 'paypal' })).rejects.toThrow(
      'provider mismatch',
    )
    await expect(
      replayWebhook({
        ...replay,
        normalize: async () => ({
          ...opts.normalized,
          events: opts.normalized.events.map((event) => ({ ...event, raw: { id: 'other' } })),
        }),
      }),
    ).rejects.toThrow('association mismatch')
    expect((await replayWebhook(replay)).status).toBe('processed')
    expect((await replayWebhook(replay)).status).toBe('not_replayable')
    expect(opts.provider.verifyWebhook).toHaveBeenCalledTimes(1)
    expect((await row(opts.normalized.providerEventId)).attempts).toBe(2)
  })

  it('prepares before processing and the queue reads committed effects; queue failure remains observable', async () => {
    const opts = input()
    const prepare = vi.fn(async () => {
      expect(await effects()).toEqual([])
      return { enriched: true }
    })
    const notify = vi.fn(async () => {
      expect(await effects()).toHaveLength(1)
      expect((await row(opts.normalized.providerEventId)).status).toBe('processed')
      throw new Error('Queue unavailable')
    })
    const result = await processWebhook({
      ...opts,
      prepare,
      notify,
      handler: async (tx, event, context) => {
        expect(context.prepared.enriched).toBe(true)
        await effect(tx, event)
      },
    })
    expect(result).toMatchObject({
      status: 'processed',
      notification: { status: 'failed', error: 'Queue unavailable' },
    })
    expect((await processWebhook({ ...opts, notify })).status).toBe('duplicate')
    expect(notify).toHaveBeenCalledTimes(1)
    expect((await row(opts.normalized.providerEventId)).attempts).toBe(1)
  })

  it('records preparation failure and stores unsupported original payload only after verification', async () => {
    const opts = input()
    expect(
      (
        await processWebhook({
          ...opts,
          prepare: async () => {
            throw new Error('Enrichment failed')
          },
        })
      ).status,
    ).toBe('failed')
    expect((await row(opts.normalized.providerEventId)).attempts).toBe(1)
    const ignored = input(0)
    expect((await processWebhook(ignored)).status).toBe('ignored')
    expect(await row(ignored.normalized.providerEventId)).toMatchObject({
      attempts: 1,
      payload: JSON.parse(ignored.rawBody),
    })
    expect((await processWebhook(ignored)).status).toBe('duplicate')
  })

  it('a delayed failed marker cannot overwrite a concurrent success and counts both attempts', async () => {
    const opts = input()
    const started = gate()
    const fail = gate()
    const retryStarted = gate()
    const finishRetry = gate()
    const first = processWebhook({
      ...opts,
      handler: async () => {
        started.resolve()
        await fail.promise
        throw new Error('First attempt failed')
      },
    })
    await started.promise
    const second = processWebhook({
      ...opts,
      handler: async (tx, event) => {
        retryStarted.resolve()
        await finishRetry.promise
        await effect(tx, event)
      },
    })
    // Wait until the second processing transaction is queued on this delivery's row lock.
    const secondPid = await db.$client`select pg_backend_pid() as pid`
    expect(secondPid).toHaveLength(1)
    for (let i = 0; i < 100; i++) {
      const waiters =
        await db.$client`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%webhook_event%for update%'`
      if (waiters.length) break
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (i === 99) throw new Error('Retry did not queue on the delivery lock')
    }
    fail.resolve()
    await retryStarted.promise
    finishRetry.resolve()
    expect((await first).status).toBe('failed')
    expect((await second).status).toBe('processed')
    expect(await row(opts.normalized.providerEventId)).toMatchObject({
      status: 'processed',
      attempts: 2,
      error: null,
    })
    expect(await effects()).toHaveLength(1)
  })
  it('failure hook sees original cause and prepared context after rollback and failed marker commit', async () => {
    const opts = input(2)
    const cause = new Error('domain conflict')
    const prepared = { immutable: 'receipt' }
    const hook = vi.fn(async (failure) => {
      expect(failure.cause).toBe(cause)
      expect(failure.prepared).toBe(prepared)
      expect(failure.events).toBe(opts.normalized.events)
      expect(failure.delivery.status).toBe('failed')
      expect((await row(opts.normalized.providerEventId)).status).toBe('failed')
      expect(await effects()).toEqual([])
    })
    expect(
      (
        await processWebhook({
          ...opts,
          prepare: async () => prepared,
          onFailure: hook,
          handler: async (tx, event) => {
            await effect(tx, event)
            throw cause
          },
        })
      ).status,
    ).toBe('failed')
    expect(hook).toHaveBeenCalledTimes(1)
  })
})
