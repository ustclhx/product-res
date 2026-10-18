import { inspect } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderEmail } from '../../render.tsx'
import { type EmailMessage, EmailSendError } from '../../sender.ts'
import { createSmtpSender } from '../index.ts'

const control = process.env.SMTP_FIXTURE_CONTROL
const ports: Record<string, string> = JSON.parse(process.env.SMTP_FIXTURE_PORTS ?? '{}')
if (!control) throw new Error('Run SMTP tests through test:node:smtp')

interface FixtureState {
  connections: number
  externalReads: number
  commands: { command: string; secured: boolean }[]
  messages: { raw: string; secured: boolean }[]
}

const sensitive = {
  response: 'SMTP_FIXTURE_PRIVATE_RESPONSE',
  user: 'SMTP_FIXTURE_PRIVATE_USER',
  password: 'SMTP_FIXTURE_PRIVATE_PASSWORD',
  recipient: 'SMTP_FIXTURE_PRIVATE_RECIPIENT@example.invalid',
  body: 'SMTP_FIXTURE_PRIVATE_BODY',
}
const message: EmailMessage = {
  to: sensitive.recipient,
  subject: 'SMTP fixture',
  html: `<p>${sensitive.body}</p>`,
  text: sensitive.body,
  idempotencyKey: 'fixture-stable-business-message',
}

async function configure(options: Record<string, unknown> = {}) {
  const response = await fetch(`${control}/configure`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
  expect(response.ok).toBe(true)
}
async function fixtureState(): Promise<FixtureState> {
  return (await fetch(`${control}/state`)).json() as Promise<FixtureState>
}
function sender(port: number, tlsMode: 'implicit' | 'starttls' | 'none', authenticated = false) {
  return createSmtpSender({
    host: '127.0.0.1',
    port: Number(ports[port]),
    tlsMode,
    from: 'Fixture Sender <sender@example.invalid>',
    replyTo: 'default-reply@example.invalid',
    connectionTimeoutMs: 500,
    greetingTimeoutMs: 500,
    socketTimeoutMs: 500,
    ...(authenticated ? { user: sensitive.user, password: sensitive.password } : {}),
  })
}
function assertSafe(error: EmailSendError) {
  const surfaces = [
    error.message,
    error.stack,
    inspect(error.cause, { depth: 10 }),
    JSON.stringify(error),
    inspect(error, { depth: 10 }),
  ].join('\n')
  for (const value of Object.values(sensitive)) expect(surfaces).not.toContain(value)
  expect(error).not.toHaveProperty('cause')
}
async function failure(send: () => Promise<unknown>) {
  try {
    await send()
  } catch (error) {
    expect(error).toBeInstanceOf(EmailSendError)
    const emailError = error as EmailSendError
    assertSafe(emailError)
    return emailError
  }
  throw new Error('Expected SMTP send to fail')
}
function headers(raw: string): Record<string, string> {
  const headerBlock = raw.split('\r\n\r\n')[0] ?? ''
  return Object.fromEntries(
    headerBlock
      .replace(/\r\n[ \t]+/g, ' ')
      .split('\r\n')
      .map((line) => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
      }),
  )
}
function mimeBody(raw: string, type: 'text/plain' | 'text/html'): string {
  const boundary = headers(raw)['content-type']?.match(/boundary="([^"]+)"/)?.[1]
  if (!boundary) throw new Error('Expected multipart template email')
  const part = raw
    .split(`--${boundary}`)
    .find((value) => headers(value.trimStart())['content-type']?.startsWith(type))
  if (!part) throw new Error(`Missing ${type} template body`)
  const content = part.trimStart()
  const body = content.slice(content.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
  const encoding = headers(content)['content-transfer-encoding']
  if (encoding === 'base64') return Buffer.from(body, 'base64').toString('utf8')
  if (encoding === 'quoted-printable') {
    const bytes = body
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  }
  return body
}

describe('Node SMTP sender with local Docker protocol fixture', () => {
  beforeEach(() => configure())

  it('delivers the rendered HTML/text, configured sender, reply addresses and list headers with stable identity', async () => {
    const rendered = await renderEmail(
      'newsletter',
      {
        subject: 'Fixture newsletter',
        body: 'Template body with a local link.',
        unsubscribeUrl: 'https://example.invalid/unsubscribe/fixture',
      },
      { locale: 'en', appName: 'Fixture app' },
    )
    const smtp = sender(2525, 'none')
    const templateMessage = { ...message, ...rendered }
    const first = await smtp.send(templateMessage)
    const second = await sender(2525, 'none').send({
      ...templateMessage,
      replyTo: 'override@example.invalid',
    })
    const state = await fixtureState()
    expect(state.messages).toHaveLength(2)
    const captured = state.messages[0]
    const override = state.messages[1]
    if (!captured || !override) throw new Error('Expected two captured messages')
    const receivedHeaders = headers(captured.raw)
    expect(receivedHeaders.from).toBe('Fixture Sender <sender@example.invalid>')
    expect(receivedHeaders.to).toBe(message.to)
    expect(receivedHeaders.subject).toBe(rendered.subject)
    expect(receivedHeaders['reply-to']).toBe('default-reply@example.invalid')
    expect(headers(override.raw)['reply-to']).toBe('override@example.invalid')
    expect(receivedHeaders['list-unsubscribe']).toBe(rendered.headers?.['List-Unsubscribe'])
    expect(receivedHeaders['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click')
    expect(mimeBody(captured.raw, 'text/html').replace(/\r\n/g, '\n')).toBe(
      rendered.html.replace(/\r\n/g, '\n'),
    )
    expect(mimeBody(captured.raw, 'text/plain').replace(/\r\n/g, '\n')).toBe(
      rendered.text.replace(/\r\n/g, '\n'),
    )
    expect(first.id).toBe(second.id)
    expect(receivedHeaders['message-id']).toBe(headers(override.raw)['message-id'])
    expect(first.id).toBe(receivedHeaders['message-id'])
    expect(captured.secured).toBe(false)
  })

  it.each([
    [2465, 'implicit'],
    [2587, 'starttls'],
  ] as const)('delivers through certificate-verified %s / %s TLS', async (port, mode) => {
    await sender(port, mode).send(message)
    const state = await fixtureState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.secured).toBe(true)
    const deliveryCommands = state.commands.filter(({ command }) =>
      ['MAIL', 'RCPT', 'DATA'].includes(command),
    )
    expect(deliveryCommands).toHaveLength(3)
    expect(deliveryCommands.every(({ secured }) => secured)).toBe(true)
    expect(state.commands.some(({ command }) => command === 'STARTTLS')).toBe(mode === 'starttls')
  })

  it.each([
    [2466, 'implicit', 'hostname mismatch'],
    [2467, 'implicit', 'untrusted CA'],
    [2589, 'starttls', 'hostname mismatch'],
    [2590, 'starttls', 'untrusted CA'],
  ] as const)(
    'rejects TLS certificate %s / %s / %s before delivery',
    async (port, mode, _reason) => {
      await failure(() => sender(port, mode, true).send(message))
      const state = await fixtureState()
      expect(state.messages).toHaveLength(0)
      expect(state.commands.some(({ command }) => ['AUTH', 'MAIL', 'DATA'].includes(command))).toBe(
        false,
      )
      expect(state.commands.some(({ command }) => command === 'STARTTLS')).toBe(mode === 'starttls')
    },
  )

  it('requires STARTTLS and never sends authentication or DATA to a server without it', async () => {
    await failure(() => sender(2588, 'starttls', true).send(message))
    const state = await fixtureState()
    expect(state.messages).toHaveLength(0)
    expect(state.commands.some(({ command }) => ['AUTH', 'MAIL', 'DATA'].includes(command))).toBe(
      false,
    )
  })

  it('sends only rendered fields when runtime input supplies file or URL attachment options', async () => {
    const extraFields = {
      ...message,
      attachments: [
        { filename: 'local-secret', path: '/missing-smtp-fixture-secret' },
        { filename: 'remote-secret', path: `${control}/forbidden-attachment` },
      ],
    }
    await sender(2525, 'none').send(extraFields)
    const state = await fixtureState()
    expect(state.externalReads).toBe(0)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.raw).not.toContain('Content-Disposition: attachment')
    expect(state.messages[0]?.raw).not.toContain('local-secret')
    expect(state.messages[0]?.raw).not.toContain('remote-secret')
  })

  it('rejects a local recipient header injection without connecting and without exposing the input', async () => {
    const error = await failure(() =>
      sender(2525, 'none').send({
        ...message,
        to: `${sensitive.recipient}\r\nBcc: extra@example.invalid`,
      }),
    )
    expect(error.retryable).toBe(false)
    expect((await fixtureState()).connections).toBe(0)
  })

  it.each([
    ['auth', 451, true],
    ['auth', 454, true],
    ['rcpt', 451, true],
    ['auth', 535, false],
    ['rcpt', 550, false],
  ] as const)(
    'classifies %s response %s using SMTP status and redacts all error surfaces',
    async (errorAt, status, retryable) => {
      await configure({ errorAt, status })
      const error = await failure(() => sender(2525, 'none', true).send(message))
      expect(error.status).toBe(status)
      expect(error.retryable).toBe(retryable)
      const state = await fixtureState()
      expect(state.connections).toBe(1)
      expect(state.messages).toHaveLength(0)
    },
  )

  it.each(['greeting-timeout', 'socket-timeout', 'disconnect'] as const)(
    'bounds and redacts %s failures without internal retry',
    async (behavior) => {
      await configure({ behavior })
      const start = Date.now()
      const error = await failure(() => sender(2525, 'none', true).send(message))
      expect(error.retryable).toBe(true)
      expect(error.status).toBeUndefined()
      expect(Date.now() - start).toBeLessThan(3000)
      const state = await fixtureState()
      expect(state.connections).toBe(1)
      expect(state.messages).toHaveLength(0)
    },
  )

  it('preserves Message-ID when the server accepts DATA then disconnects before confirmation', async () => {
    const smtp = sender(2525, 'none')
    await configure({ behavior: 'accepted-close' })
    const error = await failure(() => smtp.send(message))
    expect(error.retryable).toBe(true)
    const uncertain = (await fixtureState()).messages[0]
    expect(uncertain).toBeDefined()
    await configure()
    await sender(2525, 'none').send(message)
    const replay = (await fixtureState()).messages[0]
    expect(replay).toBeDefined()
    expect(headers(uncertain?.raw ?? '')['message-id']).toBe(
      headers(replay?.raw ?? '')['message-id'],
    )
  })

  it.each([
    [451, true],
    [550, false],
  ] as const)(
    'does not report whole-message success after second RCPT returns %s',
    async (status, retryable) => {
      await configure({ errorAt: 'rcpt', status, rejectSecondRecipient: true })
      const error = await failure(() =>
        sender(2525, 'none').send({
          ...message,
          to: [sensitive.recipient, 'second-recipient@example.invalid'],
        }),
      )
      expect(error.status).toBe(status)
      expect(error.retryable).toBe(retryable)
      const state = await fixtureState()
      expect(state.commands.filter(({ command }) => command === 'RCPT')).toHaveLength(2)
      expect(state.messages).toHaveLength(1)
    },
  )

  it('attempts explicit authentication even without AUTH advertisement and never sends anonymously after rejection', async () => {
    await configure({ hideAuth: true, errorAt: 'auth', status: 535 })
    const error = await failure(() => sender(2525, 'none', true).send(message))
    expect(error.status).toBe(535)
    expect(error.retryable).toBe(false)
    const state = await fixtureState()
    expect(state.commands.some(({ command }) => command === 'AUTH')).toBe(true)
    expect(state.commands.some(({ command }) => ['MAIL', 'DATA'].includes(command))).toBe(false)
    expect(state.messages).toHaveLength(0)
  })
})
