import { describe, expect, it } from 'vitest'
import { EmailSendError } from '../sender.ts'
import { createSmtpSender, type SmtpSenderOptions } from './index.ts'

const config: SmtpSenderOptions = {
  host: '127.0.0.1',
  port: 2525,
  tlsMode: 'none',
  from: 'App <noreply@example.com>',
}
const message = {
  to: 'reader@example.com',
  subject: 'Test',
  html: '<p>Test</p>',
  text: 'Test',
}

describe('SMTP local validation', () => {
  it('rejects invalid configuration without exposing its values', () => {
    for (const invalid of [
      { host: 'smtp://sensitive@example.com' },
      { port: 0 },
      { port: 65536 },
      { tlsMode: 'optional' },
      { user: 'sensitive-user' },
      { password: 'sensitive-password' },
      { from: 'sensitive-address' },
      { replyTo: 'invalid' },
      { socketTimeoutMs: 0 },
    ]) {
      const error = (() => {
        try {
          createSmtpSender({ ...config, ...invalid } as SmtpSenderOptions)
        } catch (error) {
          return error
        }
        throw new Error('Invalid SMTP configuration was accepted')
      })()
      expect(error).toBeInstanceOf(EmailSendError)
      expect(error).toMatchObject({ message: 'SMTP_CONFIG_INVALID', retryable: false })
      expect(error).not.toHaveProperty('cause')
    }
  })

  it('rejects local invalid messages and header injection before any connection', async () => {
    const sender = createSmtpSender(config)
    for (const invalid of [
      { to: [] },
      { to: 'invalid' },
      { replyTo: 'invalid' },
      { subject: 'subject\r\nBcc: secret@example.com' },
      { html: { path: '/should-not-read' } },
      { text: { href: 'https://should-not-fetch.invalid' } },
      {
        headers: {
          'List-Unsubscribe': '<https://product.ezarouter.cc>\r\nBcc: secret@example.com',
        },
      },
    ]) {
      const error = await sender.send({ ...message, ...invalid } as typeof message).catch((e) => e)
      expect(error).toBeInstanceOf(EmailSendError)
      expect(error).toMatchObject({
        message: 'SMTP_MESSAGE_INVALID',
        retryable: false,
      })
      expect(error).not.toHaveProperty('cause')
    }
  })
})
