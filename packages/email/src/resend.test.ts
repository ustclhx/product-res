import { describe, expect, it, vi } from 'vitest'
import { createResendSender, RESEND_API_URL } from './resend.ts'
import { type EmailMessage, EmailSendError } from './sender.ts'

const message: EmailMessage = {
  to: 'ada@example.com',
  subject: 'Verify your email',
  html: '<p>Hi</p>',
  text: 'Hi',
}

/** 每次调用返回一个新的 Response（响应体只能读一次）。 */
function mockFetch(response: (() => Response) | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response
    return response()
  })
}

function json(body: unknown, status = 200): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

async function sendError(promise: Promise<unknown>): Promise<EmailSendError> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(EmailSendError)
  return error as EmailSendError
}

describe('createResendSender', () => {
  it('posts the message to the Resend API', async () => {
    const fetch = mockFetch(json({ id: 'email_123' }))
    const sender = createResendSender({
      apiKey: 're_test_fake',
      from: 'Acme <noreply@acme.test>',
      replyTo: 'support@acme.test',
      fetch,
    })

    await expect(sender.send({ ...message, idempotencyKey: 'msg-1' })).resolves.toEqual({
      id: 'email_123',
    })

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(RESEND_API_URL)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      authorization: 'Bearer re_test_fake',
      'content-type': 'application/json',
      'idempotency-key': 'msg-1',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'Acme <noreply@acme.test>',
      to: ['ada@example.com'],
      subject: 'Verify your email',
      html: '<p>Hi</p>',
      text: 'Hi',
      reply_to: 'support@acme.test',
    })
  })

  it('lets the message override reply-to and omits optional fields', async () => {
    const fetch = mockFetch(json({ id: 'email_456' }))
    const sender = createResendSender({ apiKey: 'k', from: 'noreply@acme.test', fetch })

    await sender.send({ ...message, to: ['a@example.com', 'b@example.com'] })
    await sender.send({ ...message, replyTo: 'owner@example.com' })

    const first = fetch.mock.calls[0]?.[1]
    expect(first?.headers).not.toHaveProperty('idempotency-key')
    const firstBody = JSON.parse(String(first?.body))
    expect(firstBody.to).toEqual(['a@example.com', 'b@example.com'])
    expect(firstBody).not.toHaveProperty('reply_to')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).reply_to).toBe('owner@example.com')
  })

  it.each([500, 502, 503, 429])('marks %i as retryable', async (status) => {
    const sender = createResendSender({
      apiKey: 'k',
      from: 'noreply@acme.test',
      fetch: mockFetch(json({ name: 'internal_server_error', message: 'boom' }, status)),
    })
    const error = await sendError(sender.send(message))
    expect(error.status).toBe(status)
    expect(error.retryable).toBe(true)
  })

  it('marks validation errors as permanent without echoing the recipient', async () => {
    const sender = createResendSender({
      apiKey: 'k',
      from: 'noreply@acme.test',
      fetch: mockFetch(
        json({ name: 'validation_error', message: 'Invalid `to` field: ada@example.com' }, 422),
      ),
    })
    const error = await sendError(sender.send(message))
    expect(error.status).toBe(422)
    expect(error.retryable).toBe(false)
    expect(error.message).toBe('Resend responded 422 (validation_error)')
    expect(error.message).not.toContain('ada@example.com')
  })

  it('treats network failures as retryable', async () => {
    const cause = new TypeError('fetch failed')
    const sender = createResendSender({
      apiKey: 'k',
      from: 'noreply@acme.test',
      fetch: mockFetch(cause),
    })
    const error = await sendError(sender.send(message))
    expect(error.status).toBeUndefined()
    expect(error.retryable).toBe(true)
    expect(error.cause).toBe(cause)
  })

  it('rejects a success response without an id', async () => {
    const sender = createResendSender({
      apiKey: 'k',
      from: 'noreply@acme.test',
      fetch: mockFetch(() => new Response('not json', { status: 200 })),
    })
    const error = await sendError(sender.send(message))
    expect(error.retryable).toBe(false)
  })
})
