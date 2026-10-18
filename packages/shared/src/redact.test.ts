import { describe, expect, it } from 'vitest'
import { isSensitiveKey, REDACTED, redact } from './redact.ts'

describe('redact', () => {
  it('removes credentials and conversation content from an error event', () => {
    const request = new Request('https://app.test/api/ai/chat?token=abc', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-live-secret',
        Cookie: 'session=s3cr3t',
        'content-type': 'application/json',
      },
    })
    const event = {
      event: 'ai.chat.failed',
      request,
      headers: new Headers({ authorization: 'Bearer abc', 'x-trace': 'kept' }),
      body: {
        email: 'a@example.com',
        password: 'hunter2',
        newPassword: 'hunter3',
        message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'my secret plan' }] },
        messages: [{ role: 'user', content: 'previous turn' }],
        prompt: 'summarize my diary',
      },
      error: Object.assign(new Error('upstream failed'), { apiKey: 'sk-provider' }),
      usage: { inputTokens: 12, outputTokens: 34 },
    }

    const result = redact(event) as Record<string, Record<string, unknown>>
    const text = JSON.stringify(result)
    for (const secret of [
      'sk-live-secret',
      's3cr3t',
      'Bearer abc',
      'hunter2',
      'hunter3',
      'my secret plan',
      'previous turn',
      'summarize my diary',
      'token=abc',
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(result.request).toEqual({
      method: 'POST',
      url: 'https://app.test/api/ai/chat',
      headers: { authorization: REDACTED, cookie: REDACTED, 'content-type': 'application/json' },
    })
    expect(result.headers).toEqual({ authorization: REDACTED, 'x-trace': 'kept' })
    expect(result.body?.message).toEqual({ id: 'm1', role: 'user', parts: REDACTED })
    expect(result.body?.messages).toBe(REDACTED)
    expect(result.body?.prompt).toBe(REDACTED)
    expect(result.error).toMatchObject({ name: 'Error', message: 'upstream failed' })
    // 计量字段不是令牌
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
    // 不修改入参
    expect(event.body.password).toBe('hunter2')
  })

  it('matches key names case-insensitively, ignoring separators and known suffixes', () => {
    for (const key of ['Authorization', 'set-cookie', 'api_key', 'accessToken', 'client_secret'])
      expect(isSensitiveKey(key)).toBe(true)
    for (const key of ['outputTokens', 'contentType', 'messageId', 'idempotencyKey'])
      expect(isSensitiveKey(key)).toBe(false)
  })

  it('handles cycles, deep nesting and non-JSON values', () => {
    const cyclic: Record<string, unknown> = { id: 1 }
    cyclic.self = cyclic
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 20; i++) deep = { deep }
    expect(redact(cyclic)).toEqual({ id: 1, self: '[Circular]' })
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]')
    expect(redact({ n: 10n, at: new Date(0) })).toEqual({ n: '10', at: '1970-01-01T00:00:00.000Z' })
  })
})

it('运营通知密钥的普通与 setting 键名均被脱敏', () => {
  const value = {
    telegramBotToken: 'telegram-secret',
    discordWebhookUrl: 'discord-secret',
    'operations.telegramBotToken': 'telegram-secret',
    'operations.discordWebhookUrl': 'discord-secret',
  }
  expect(JSON.stringify(redact(value))).not.toMatch(/telegram-secret|discord-secret/)
  expect(Object.values(redact(value) as Record<string, unknown>)).toEqual(Array(4).fill(REDACTED))
})
