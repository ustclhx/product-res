import type { BillingProviders, WebhookResult } from '@product-res/billing'
import type { Database } from '@product-res/db'
import { beforeEach, expect, it, vi } from 'vitest'

const process = vi.hoisted(() => vi.fn())
vi.mock('@product-res/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@product-res/billing')>()
  return {
    ...actual,
    processWebhook: process,
    createBillingEventHandler: () => ({}),
    createCompensationFailureHandler: () => vi.fn(),
  }
})

import { WebhookVerificationError } from '@product-res/billing'
import { newRequestId, withLogContext } from '@product-res/shared/log'
import { handleBillingWebhook } from './webhook-http.ts'

const options = {
  db: {} as Database,
  subscriptionCreditGraceHours: 24,
  providers: { stripe: { id: 'stripe' } } as BillingProviders,
  queue: { send: vi.fn() },
}
const request = () =>
  new Request('https://example.test/api/billing/webhooks/stripe', {
    method: 'POST',
    body: '{"id":"fixture"}',
  })
beforeEach(() => process.mockReset())
it('does not acknowledge unavailable providers or malformed deliveries', async () => {
  expect(
    (await handleBillingWebhook(request(), 'stripe', { ...options, providers: {} })).status,
  ).toBe(503)
  expect(
    (
      await handleBillingWebhook(
        new Request('https://example.test', { method: 'POST', body: 'invalid' }),
        'stripe',
        options,
      )
    ).status,
  ).toBe(400)
  expect(process).not.toHaveBeenCalled()
})
it('rejects invalid signatures but keeps transport and business failure retryable', async () => {
  process.mockRejectedValueOnce(new WebhookVerificationError('invalid'))
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(400)
  process.mockRejectedValueOnce(new Error('temporary remote failure'))
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(500)
  process.mockResolvedValueOnce({ status: 'failed' } as WebhookResult)
  expect((await handleBillingWebhook(request(), 'stripe', options)).status).toBe(500)
})
it('acknowledges committed payments even when post-commit queue delivery needs recovery', async () => {
  process.mockResolvedValueOnce({
    status: 'processed',
    notification: { status: 'failed', error: 'queue' },
  } as WebhookResult)
  const response = await handleBillingWebhook(request(), 'stripe', options)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ received: true })
})
it('enqueues the post-commit message with the request ID that its logs carry', async () => {
  const requestId = newRequestId()
  const send = vi.fn()
  const info = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.mockImplementationOnce(async ({ notify }) => {
    await notify({ delivery: { id: 'delivery-1' } })
    return { status: 'processed', delivery: { id: 'delivery-1' }, notification: { status: 'sent' } }
  })
  const response = await withLogContext({ requestId }, () =>
    handleBillingWebhook(request(), 'stripe', { ...options, queue: { send } }),
  )
  expect(response.status).toBe(200)
  expect(send).toHaveBeenCalledWith({ v: 1, deliveryId: 'delivery-1', requestId })
  expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
    event: 'billing.webhook_processed',
    requestId,
    deliveryId: 'delivery-1',
  })
  info.mockRestore()
})

it('adds payment operations only after commit and leaves failed callback responses unchanged when enqueue fails', async () => {
  const send = vi.fn()
  process.mockImplementationOnce(async ({ notify }) => {
    await notify({
      delivery: { id: 'delivery-2' },
      events: [
        {
          type: 'payment.succeeded',
          provider: 'stripe',
          payment: {
            providerPaymentId: 'pi_123',
            amount: 1000,
            currency: 'USD',
            metadata: { workspaceId: 'workspace-1' },
          },
        },
      ],
    })
    return { status: 'processed' }
  })
  expect(
    (await handleBillingWebhook(request(), 'stripe', { ...options, queue: { send } })).status,
  ).toBe(200)
  // 计费后处理与运营通知是两条独立消息
  expect(send.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ v: 1, deliveryId: 'delivery-2' }),
  )
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty('operations')
  expect(send.mock.calls[1]?.[0]).toMatchObject({
    v: 1,
    operations: [
      {
        event: 'payment.succeeded',
        sourceId: 'stripe:pi_123',
        workspaceId: 'workspace-1',
        amount: 1000,
        currency: 'USD',
      },
    ],
  })
  expect(send.mock.calls[1]?.[0]).not.toHaveProperty('deliveryId')
  process.mockResolvedValueOnce({
    status: 'failed',
    delivery: { id: 'failed-delivery', attempts: 2 },
  })
  send.mockRejectedValueOnce(new Error('Queue unavailable'))
  expect(
    (await handleBillingWebhook(request(), 'stripe', { ...options, queue: { send } })).status,
  ).toBe(500)
  expect(send.mock.calls[2]?.[0]).toMatchObject({
    v: 1,
    operations: [{ event: 'webhook.failed', sourceId: 'failed-delivery:2' }],
  })
})

it('keeps the billing delivery and callback result when only the operations enqueue fails', async () => {
  const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down'))
  process.mockImplementationOnce(async ({ notify }) => {
    await notify({
      delivery: { id: 'delivery-3' },
      events: [
        {
          type: 'payment.succeeded',
          provider: 'stripe',
          payment: { providerPaymentId: 'pi_456', amount: 500, currency: 'USD' },
        },
      ],
    })
    return { status: 'processed' }
  })
  expect(
    (await handleBillingWebhook(request(), 'stripe', { ...options, queue: { send } })).status,
  ).toBe(200)
  expect(send.mock.calls[0]?.[0]).toMatchObject({ v: 1, deliveryId: 'delivery-3' })
})
