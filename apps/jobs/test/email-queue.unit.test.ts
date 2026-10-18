import type { EmailTransportConfig } from '@product-res/config'
import type { EmailQueueMessage } from '@product-res/email/queue'
import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleEmailBatch } from '../src/queues/email.ts'

const body: EmailQueueMessage = {
  v: 1,
  template: 'reset-password',
  props: { url: 'https://product.ezarouter.cc/reset?token=private', expiresInMinutes: 60 },
  to: 'someone@example.com',
  appName: 'Test',
  idempotencyKey: 'stable-mail-key',
  requestId: 'original-request',
}
const transport: EmailTransportConfig = {
  transport: 'resend',
  apiKey: 'fixture-key',
  from: 'Test <noreply@example.com>',
  replyTo: undefined,
}
const observer = { captureException: vi.fn(), tagContext: vi.fn() }
function message(value: unknown = body, attempts = 1): QueueMessage<unknown> {
  return { id: 'mail', body: value, attempts, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() }
}
function batch(messages: QueueMessage<unknown>[]): QueueBatch<unknown> {
  return { queue: 'product-res-email', messages, ackAll: vi.fn(), retryAll: vi.fn() }
}
function reply(status: number) {
  return Response.json(status === 200 ? { id: 'sent' } : { name: 'fixture-error' }, { status })
}
beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('waits for a successful peer after dead-letter persistence rejects', async () => {
  let finish!: (value: Response) => void
  const successfulDelivery = new Promise<Response>((resolve) => {
    finish = resolve
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { to: string[] }
    return request.to[0] === 'slow@example.com' ? successfulDelivery : reply(422)
  })
  const failedEntry = message()
  const success = message({ ...body, to: 'slow@example.com' })
  const failed = vi.fn().mockRejectedValue(new Error('Persistence unavailable'))
  let settled = false
  const result = handleEmailBatch(batch([failedEntry, success]), transport, {
    observer,
    deadLetters: { failed },
  }).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  finish(reply(200))
  expect(await result).toEqual(new Error('Persistence unavailable'))
  expect(success.ack).toHaveBeenCalledOnce()
  expect(failedEntry.ack).not.toHaveBeenCalled()
  expect(failedEntry.retry).not.toHaveBeenCalled()
})

it('acks malformed messages and retries temporary failures with the original request and idempotency IDs', async () => {
  const remote = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(503))
  const invalid = message(null)
  const temporary = message(body, 2)
  const failed = vi.fn()
  await handleEmailBatch(batch([invalid, temporary]), transport, {
    observer,
    deadLetters: { failed },
  })
  expect(invalid.ack).toHaveBeenCalledOnce()
  expect(temporary.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  expect(failed).not.toHaveBeenCalled()
  expect(new Headers(remote.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
    'stable-mail-key',
  )
  expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain(
    '"requestId":"original-request"',
  )
})

it('uses the injected SMTP sender with the rendered template and stable identity', async () => {
  const remote = vi.spyOn(globalThis, 'fetch')
  const send = vi.fn().mockResolvedValue({ id: 'smtp-message-id' })
  const entry = message()
  await handleEmailBatch(batch([entry]), { transport: 'smtp' }, { sender: { send }, observer })
  expect(send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: body.to,
      subject: expect.any(String),
      html: expect.stringContaining('https://product.ezarouter.cc/reset?token=private'),
      text: expect.stringContaining('https://product.ezarouter.cc/reset?token=private'),
      idempotencyKey: body.idempotencyKey,
    }),
  )
  expect(entry.ack).toHaveBeenCalledOnce()
  expect(remote).not.toHaveBeenCalled()
})

it('rejects unassembled SMTP before processing and never falls back to another channel', async () => {
  const remote = vi.spyOn(globalThis, 'fetch')
  const entry = message()
  await expect(handleEmailBatch(batch([entry]), { transport: 'smtp' })).rejects.toThrow(
    'SMTP_SENDER_UNAVAILABLE',
  )
  expect(remote).not.toHaveBeenCalled()
  expect(entry.ack).not.toHaveBeenCalled()
  expect(entry.retry).not.toHaveBeenCalled()
})
