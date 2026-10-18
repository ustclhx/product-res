import type { EmailQueueMessage } from '@product-res/email/queue'
import type { QueueBatch, QueueMessage } from '@product-res/platform'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMAIL_MAX_ATTEMPTS, handleEmailBatch } from '../src/queues/email.ts'

const body: EmailQueueMessage = {
  v: 1,
  template: 'reset-password',
  props: { url: 'https://app.example.com/reset?token=fixture', expiresInMinutes: 60 },
  to: 'fixture@example.com',
  appName: 'Fixture',
  idempotencyKey: 'fixture-idempotency',
}
const transport = {
  transport: 'resend',
  apiKey: 'fixture-only',
  from: 'Fixture <fixture@example.com>',
  replyTo: undefined,
} as const
function batch() {
  const message: QueueMessage<unknown> = {
    id: 'fixture-message',
    timestamp: new Date(),
    body,
    attempts: EMAIL_MAX_ATTEMPTS,
    ack: vi.fn(),
    retry: vi.fn(),
  }
  const batch: QueueBatch<unknown> = {
    queue: 'product-res-email',
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  }
  return { batch, message }
}
beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it.each([
  [422, 'EMAIL_NON_RETRYABLE', false],
  [503, 'EMAIL_ATTEMPTS_EXHAUSTED', true],
] as const)(
  'hands valid terminal failure (%s) to the persistent sink without early ack',
  async (status, code, retryable) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'fixture_failure' }), { status }),
    )
    const { batch: messages, message } = batch()
    let finish!: () => void
    const persisted = new Promise<void>((resolve) => {
      finish = resolve
    })
    const failed = vi.fn(async () => {
      expect(message.ack).not.toHaveBeenCalled()
      await persisted
      message.ack()
    })
    const consuming = handleEmailBatch(messages, transport, { deadLetters: { failed } })
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
    expect(message.ack).not.toHaveBeenCalled()
    finish()
    await consuming
    expect(failed).toHaveBeenCalledWith(message, { code, retryable })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  },
)

it('leaves the valid message unacknowledged when persistent dead-letter recording fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }))
  const { batch: messages, message } = batch()
  const failed = vi.fn().mockRejectedValue(new Error('Persistent sink unavailable'))
  await expect(handleEmailBatch(messages, transport, { deadLetters: { failed } })).rejects.toThrow(
    'Persistent sink unavailable',
  )
  expect(message.ack).not.toHaveBeenCalled()
  expect(message.retry).not.toHaveBeenCalled()
})
