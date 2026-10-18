import {
  type Database,
  type JsonValue,
  type PaymentProviderId,
  type WebhookEvent,
  webhookEvent,
} from '@product-res/db'
import { and, eq, sql } from 'drizzle-orm'
import { billingErrorMessage } from './errors.ts'
import type { NormalizedEvent, PaymentProvider, VerifiedWebhook } from './provider.ts'

export type WebhookTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface WebhookContext<Prepared = undefined> {
  delivery: WebhookEvent
  prepared: Prepared
}

export interface WebhookFailure<Prepared> {
  cause: unknown
  delivery: WebhookEvent
  events: readonly NormalizedEvent[]
  prepared: Prepared | undefined
}

export interface WebhookNotification {
  delivery: WebhookEvent
  events: readonly NormalizedEvent[]
}

export type WebhookResult =
  | { status: 'duplicate' | 'not_replayable'; delivery: WebhookEvent }
  | { status: 'failed'; delivery: WebhookEvent; error: string }
  | {
      status: 'processed' | 'ignored'
      delivery: WebhookEvent
      notification: { status: 'sent' | 'not_requested' } | { status: 'failed'; error: string }
    }

export interface WebhookProcessingOptions<Prepared = undefined> {
  db: Database
  /** Database effects only. Remote enrichment belongs in prepare. */
  handler(
    tx: WebhookTransaction,
    event: NormalizedEvent,
    context: WebhookContext<Prepared>,
  ): Promise<void>
  /** Runs outside the processing transaction; return data for the database-only handler. */
  prepare?(events: readonly NormalizedEvent[], delivery: WebhookEvent): Promise<Prepared>
  /** Runs only after business rollback and the independent failed marker commit. */
  onFailure?(failure: WebhookFailure<Prepared>): Promise<void>
  /** EVENTS_QUEUE adapter. Rejection is observable without changing successful DB status. */
  notify?(notification: WebhookNotification): Promise<void>
}

function validate(normalized: VerifiedWebhook, provider: PaymentProviderId) {
  if (!normalized.providerEventId || !normalized.type) throw new Error('Invalid webhook identity')
  if (normalized.events.some((event) => event.provider !== provider)) {
    throw new Error('Webhook event provider mismatch')
  }
}

// JSONB discards object key order. Compare structurally to bind redeliveries/replay to their original payload.
function samePayload(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => samePayload(v, b[i] as JsonValue))
    )
  }
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && samePayload(a[key] as JsonValue, b[key] as JsonValue),
    )
  )
}

// Stripe 的 pending_webhooks 随投递成功而变化，不属于事件的业务身份。
function associationPayload(provider: PaymentProviderId, payload: JsonValue): JsonValue {
  if (
    provider !== 'stripe' ||
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return payload
  const association = { ...payload }
  delete association.pending_webhooks
  return association
}

function assertAssociation(
  delivery: WebhookEvent,
  normalized: VerifiedWebhook,
  provider: PaymentProviderId,
  payload: JsonValue,
) {
  validate(normalized, provider)
  if (
    delivery.provider !== provider ||
    delivery.providerEventId !== normalized.providerEventId ||
    delivery.type !== normalized.type ||
    !samePayload(
      associationPayload(provider, delivery.payload),
      associationPayload(provider, payload),
    ) ||
    normalized.events.some((event) => !samePayload(event.raw, payload))
  ) {
    throw new Error('Webhook delivery association mismatch')
  }
}

async function find(db: Database, id: string) {
  const [delivery] = await db.select().from(webhookEvent).where(eq(webhookEvent.id, id))
  if (!delivery) throw new Error('Webhook delivery not found')
  return delivery
}

async function markFailed(db: Database, id: string, error: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(webhookEvent)
      .where(eq(webhookEvent.id, id))
      .for('update')
    if (!current) throw new Error('Webhook delivery not found')
    // Every actual failed attempt counts, even if a newer attempt committed while this marker waited.
    const terminal = current.status === 'processed' || current.status === 'ignored'
    const [delivery] = await tx
      .update(webhookEvent)
      .set({
        attempts: sql`${webhookEvent.attempts} + 1`,
        ...(terminal ? {} : { status: 'failed' as const, error }),
      })
      .where(eq(webhookEvent.id, id))
      .returning()
    return delivery as WebhookEvent
  })
}

async function processRegistered<Prepared>(
  options: WebhookProcessingOptions<Prepared>,
  delivery: WebhookEvent,
  normalized: VerifiedWebhook,
  replay: boolean,
): Promise<WebhookResult> {
  if (delivery.status === 'processed' || delivery.status === 'ignored')
    return { status: replay ? 'not_replayable' : 'duplicate', delivery }
  if (replay && delivery.status !== 'failed') return { status: 'not_replayable', delivery }
  let committed: WebhookEvent
  let prepared: Prepared | undefined
  try {
    prepared = options.prepare
      ? await options.prepare(normalized.events, delivery)
      : (undefined as Prepared)
    const result = await options.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(webhookEvent)
        .where(eq(webhookEvent.id, delivery.id))
        .for('update')
      if (!current) throw new Error('Webhook delivery not found')
      if (current.status === 'processed' || current.status === 'ignored')
        return {
          status: replay ? ('not_replayable' as const) : ('duplicate' as const),
          delivery: current,
        }
      if (replay && current.status !== 'failed')
        return { status: 'not_replayable' as const, delivery: current }
      for (const event of normalized.events)
        await options.handler(tx, event, { delivery: current, prepared: prepared as Prepared })
      const [updated] = await tx
        .update(webhookEvent)
        .set({
          status: normalized.events.length ? 'processed' : 'ignored',
          processedAt: new Date(),
          error: null,
          attempts: sql`${webhookEvent.attempts} + 1`,
        })
        .where(eq(webhookEvent.id, current.id))
        .returning()
      return { status: 'committed' as const, delivery: updated as WebhookEvent }
    })
    if (result.status !== 'committed') return result
    committed = result.delivery
  } catch (cause) {
    const error = billingErrorMessage(cause)
    const failed = await markFailed(options.db, delivery.id, error)
    await options.onFailure?.({ cause, delivery: failed, events: normalized.events, prepared })
    return { status: 'failed', error, delivery: failed }
  }
  let notification: Extract<WebhookResult, { notification: unknown }>['notification'] = {
    status: 'not_requested',
  }
  if (options.notify) {
    try {
      await options.notify({ delivery: committed, events: normalized.events })
      notification = { status: 'sent' }
    } catch (cause) {
      notification = { status: 'failed', error: billingErrorMessage(cause) }
    }
  }
  return {
    status: normalized.events.length ? 'processed' : 'ignored',
    delivery: committed,
    notification,
  }
}

/** Fresh HTTP delivery: signature verification precedes parsing, registration and all transactions. */
export async function processWebhook<Prepared = undefined>(
  options: WebhookProcessingOptions<Prepared> & {
    provider: PaymentProvider
    request: Request
    rawBody: string
  },
): Promise<WebhookResult> {
  const normalized = await options.provider.verifyWebhook(options.request, options.rawBody)
  validate(normalized, options.provider.id)
  const payload = JSON.parse(options.rawBody) as JsonValue
  if (normalized.events.some((event) => !samePayload(event.raw, payload))) {
    throw new Error('Webhook event raw payload mismatch')
  }
  const delivery = await options.db.transaction(async (tx) => {
    await tx
      .insert(webhookEvent)
      .values({
        provider: options.provider.id,
        providerEventId: normalized.providerEventId,
        type: normalized.type,
        payload,
      })
      .onConflictDoNothing({ target: [webhookEvent.provider, webhookEvent.providerEventId] })
    const [row] = await tx
      .select()
      .from(webhookEvent)
      .where(
        and(
          eq(webhookEvent.provider, options.provider.id),
          eq(webhookEvent.providerEventId, normalized.providerEventId),
        ),
      )
    if (!row) throw new Error('Webhook registration failed')
    return row
  })
  assertAssociation(delivery, normalized, options.provider.id, payload)
  return processRegistered(options, delivery, normalized, false)
}

/** Trusted internal primitive. The admin route must authorize the actor before calling this. */
export async function replayWebhook<Prepared = undefined>(
  options: WebhookProcessingOptions<Prepared> & {
    webhookEventId: string
    providerId: PaymentProviderId
    normalize(payload: JsonValue): Promise<VerifiedWebhook>
  },
): Promise<WebhookResult> {
  const delivery = await find(options.db, options.webhookEventId)
  if (delivery.provider !== options.providerId) throw new Error('Webhook replay provider mismatch')
  if (delivery.status !== 'failed') return { status: 'not_replayable', delivery }
  // Re-normalize a copy: the callback cannot mutate the stored payload used to establish association.
  const normalized = await options.normalize(structuredClone(delivery.payload))
  assertAssociation(delivery, normalized, options.providerId, delivery.payload)
  return processRegistered(options, delivery, normalized, true)
}
