import { betterAuth } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { describe, expect, it, vi } from 'vitest'
import { authProtection } from './protection.ts'

const paths = ['/email-otp/verify-email', '/email-otp/reset-password']

describe('验证码消费入口限流', () => {
  it.each(paths)('%s 无需 Turnstile，共享 IP 与规范化邮箱额度，超限不执行端点', async (path) => {
    const next = vi.fn(async () => ({ ok: true }))
    const counts = new Map<string, number>()
    const limit = vi.fn(async (_policy: string, key: string) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return { success: count <= 1 }
    })
    const auth = betterAuth({
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
      plugins: [
        authProtection({
          rateLimiter: { limit },
          clientIp: '198.51.100.1',
          turnstileSecret: 'enabled',
        }),
        { id: 'probe', endpoints: { probe: createAuthEndpoint(path, { method: 'POST' }, next) } },
      ],
    })
    const post = () =>
      auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ email: ' User@Example.com ' }),
        }),
      )
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(429)
    expect(next).toHaveBeenCalledTimes(1)
    expect(limit.mock.calls[0]).toEqual(['auth', 'auth:ip:198.51.100.1'])
    const hash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('user@example.com')),
    ).toString('hex')
    expect(limit.mock.calls[1]).toEqual(['auth', `auth:email:${hash}`])
  })

  it('已有 OTP 登录入口保留 Turnstile 校验', async () => {
    const plugin = authProtection({ clientIp: '198.51.100.1', turnstileSecret: 'enabled' })
    const auth = betterAuth({
      baseURL: 'http://localhost:3000',
      plugins: [
        plugin,
        {
          id: 'probe',
          endpoints: {
            probe: createAuthEndpoint('/sign-in/email-otp', { method: 'POST' }, async () => ({
              ok: true,
            })),
          },
        },
      ],
    })
    const response = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(403)
  })
})

it('令牌重置密码入口在端点校验前限流', async () => {
  const limit = vi.fn(async () => ({ success: false }))
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    plugins: [
      authProtection({
        rateLimiter: { limit },
        clientIp: '198.51.100.1',
        turnstileSecret: 'enabled',
      }),
    ],
  })
  const result = await auth.handler(
    new Request('http://localhost:3000/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ token: 'invalid-token', newPassword: 'correct-horse-battery-staple' }),
    }),
  )
  expect(result.status).toBe(429)
  expect(await result.json()).toMatchObject({ code: 'RATE_LIMITED' })
  expect(limit).toHaveBeenCalledWith('auth', 'auth:ip:198.51.100.1')
})

it('消费端点的邮箱额度与发信端点共用，换 IP 仍被拦截且不执行消费处理器', async () => {
  const next = vi.fn(async () => ({ ok: true }))
  const seenEmails = new Set<string>()
  const limiter = {
    limit: vi.fn(async (_policy: string, key: string) => {
      if (!key.startsWith('auth:email:')) return { success: true }
      if (seenEmails.has(key)) return { success: false }
      seenEmails.add(key)
      return { success: true }
    }),
  }
  const make = (ip: string) =>
    betterAuth({
      baseURL: 'http://localhost:3000',
      plugins: [
        authProtection({ clientIp: ip, turnstileSecret: null, rateLimiter: limiter }),
        {
          id: 'probe',
          endpoints: {
            send: createAuthEndpoint(
              '/email-otp/send-verification-otp',
              { method: 'POST' },
              async () => ({ ok: true }),
            ),
            consume: createAuthEndpoint('/email-otp/verify-email', { method: 'POST' }, next),
          },
        },
      ],
    })
  const post = (ip: string, path: string, email: string) =>
    make(ip).handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email }),
      }),
    )
  expect(
    (await post('198.51.100.1', '/email-otp/send-verification-otp', 'User@example.com')).status,
  ).toBe(200)
  expect((await post('198.51.100.2', '/email-otp/verify-email', ' user@EXAMPLE.com ')).status).toBe(
    429,
  )
  expect(next).not.toHaveBeenCalled()
})
