import { betterAuth } from 'better-auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TURNSTILE_TOKEN_HEADER } from '../src/index.ts'
import {
  cookieHeader,
  countingRateLimiter,
  mockTurnstile,
  nextIp,
  PASSWORD,
  setup,
  signUpBody,
  TURNSTILE_FAIL_SECRET,
  testUsers,
} from './helpers.ts'

// 认证入口防刷（tasks.md 2.5，specs/user-auth「认证入口防刷」）：
// Turnstile 用 Cloudflare 官方测试 secret（siteverify 由 mockTurnstile 按其文档行为模拟），
// RL_AUTH 默认为 Miniflare 模拟的 Rate Limiting 绑定（test/wrangler.jsonc：每个 key 每 60 秒 5 次）。
// 该绑定的窗口按墙钟整分钟对齐，测试跨过边界时计数会被清零；因此断言精确放行次数的限流测试
// 注入与时间无关的 countingRateLimiter（同样每个 key 5 次），真实绑定只做与窗口无关的接线检查。

const users = testUsers('protection')
let siteverify: ReturnType<typeof mockTurnstile>

beforeAll(() => users.start())
beforeEach(() => {
  siteverify = mockTurnstile()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

const findUser = (s: ReturnType<typeof setup>, address: string) =>
  s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, address) })

const noToken = { [TURNSTILE_TOKEN_HEADER]: '' }

describe('Turnstile', () => {
  it('注册请求不带令牌时被拒绝，不创建用户、不调用 siteverify', async () => {
    const s = setup()
    const address = users.email('no-token')
    const res = await s.post('/sign-up/email', signUpBody(address), noToken)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('TURNSTILE_FAILED')
    expect(await findUser(s, address)).toBeUndefined()
    expect(siteverify).not.toHaveBeenCalled()
  })

  it('令牌无效（始终失败的测试 secret）时注册被拒绝，不创建用户', async () => {
    const s = setup({ env: { TURNSTILE_SECRET_KEY: TURNSTILE_FAIL_SECRET } })
    const address = users.email('bad-token')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(403)
    expect(await findUser(s, address)).toBeUndefined()
    expect(siteverify).toHaveBeenCalledTimes(1)
  })

  it('siteverify 不可达时按失败处理（fail closed）', async () => {
    siteverify.mockRejectedValue(new TypeError('network down'))
    const s = setup()
    const address = users.email('verify-down')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(403)
    expect(await findUser(s, address)).toBeUndefined()
  })

  it('令牌有效（始终通过的测试 secret）时注册、登录、发送验证码、找回密码正常', async () => {
    const s = setup()
    const address = users.email('pass')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    expect((await s.post('/sign-in/email', { email: address, password: PASSWORD })).status).toBe(
      200,
    )
    expect(
      (await s.post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' }))
        .status,
    ).toBe(200)
    expect((await s.post('/request-password-reset', { email: address })).status).toBe(200)
    expect(s.sent.map((m) => m.type)).toEqual(['otp', 'reset-password'])
    // 每个请求都校验了令牌，且带上客户端 IP
    expect(siteverify).toHaveBeenCalledTimes(4)
    const form = siteverify.mock.calls[0]?.[1]?.body as FormData
    expect(form.get('remoteip')).toBe(s.ip)
  })

  it('登录、发送验证码、找回密码、魔法链接缺少令牌时都被拒绝且不发邮件', async () => {
    const s = setup({ config: { auth: { magicLink: true } } })
    const address = users.email('all-entries')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    // 每个请求换一个 IP，避免触发 IP 维度的限流
    const headers = () => ({ ...noToken, 'cf-connecting-ip': nextIp() })
    const attempts = [
      s.post('/sign-in/email', { email: address, password: PASSWORD }, headers()),
      s.post('/email-otp/send-verification-otp', { email: address, type: 'sign-in' }, headers()),
      s.post('/request-password-reset', { email: address }, headers()),
      s.post('/forget-password/email-otp', { email: address }, headers()),
      s.post('/sign-in/magic-link', { email: address }, headers()),
    ]
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403)
    expect(s.sent).toEqual([])
  })

  it('模板配置关闭 Turnstile 时不要求令牌，也不需要 TURNSTILE_SECRET_KEY', async () => {
    const s = setup({
      config: { auth: { turnstile: false } },
      env: { TURNSTILE_SECRET_KEY: undefined },
    })
    const address = users.email('off')
    expect((await s.post('/sign-up/email', signUpBody(address), noToken)).status).toBe(200)
    expect(siteverify).not.toHaveBeenCalled()
  })

  it('不受保护的接口不校验令牌', async () => {
    const s = setup()
    const res = await s.get('/get-session', noToken)
    expect(res.status).toBe(200)
    expect(siteverify).not.toHaveBeenCalled()
  })
})

describe('RL_AUTH 限流', () => {
  it('同一邮箱连续发送验证码超过限额后返回 429，且不再发送邮件', async () => {
    const s = setup({ rateLimiter: countingRateLimiter() })
    const address = users.email('otp-flood')
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      // 每次换一个 IP：只触发邮箱维度的限流
      const res = await s.post(
        '/email-otp/send-verification-otp',
        { email: address, type: 'sign-in' },
        { 'cf-connecting-ip': nextIp() },
      )
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429])
    expect(s.sent).toHaveLength(5)
    expect(s.sent.every((m) => m.type === 'otp' && m.to === address)).toBe(true)
  })

  it('邮箱大小写与首尾空格不同视为同一邮箱', async () => {
    const s = setup({ rateLimiter: countingRateLimiter() })
    const address = users.email('case')
    const variants = [address, address.toUpperCase(), ` ${address} `]
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await s.post(
        '/request-password-reset',
        { email: variants[i % variants.length] },
        { 'cf-connecting-ip': nextIp() },
      )
      statuses.push(res.status)
    }
    expect(statuses.at(-1)).toBe(429)
  })

  it('同一 IP 超过限额后返回 429（找回密码不发邮件、注册不创建用户）', async () => {
    const s = setup({ rateLimiter: countingRateLimiter() })
    const address = users.email('ip-flood')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    for (let i = 0; i < 4; i++) {
      expect(
        (await s.post('/request-password-reset', { email: users.email(`x${i}`) })).status,
      ).toBe(200)
    }
    const sentBefore = s.sent.length
    const reset = await s.post('/request-password-reset', { email: address })
    expect(reset.status).toBe(429)
    expect(((await reset.json()) as { code: string }).code).toBe('RATE_LIMITED')
    const another = users.email('ip-flood-2')
    expect((await s.post('/sign-up/email', signUpBody(another))).status).toBe(429)
    expect(await findUser(s, another)).toBeUndefined()
    expect(s.sent.length).toBe(sentBefore)
    // 超限的请求不调用 siteverify
    expect(siteverify).toHaveBeenCalledTimes(5)
  })

  it('服务端直接调用 auth.api 不经过限流与 Turnstile', async () => {
    const s = setup({ rateLimiter: countingRateLimiter() })
    const address = users.email('server-call')
    for (let i = 0; i < 7; i++) {
      await s.auth.api.sendVerificationOTP({ body: { email: address, type: 'sign-in' } })
    }
    expect(s.sent).toHaveLength(7)
    expect(siteverify).not.toHaveBeenCalled()
  })

  it('已登录用户主动发送验证邮件不要求 Turnstile，但同样限流', async () => {
    const s = setup({ rateLimiter: countingRateLimiter() })
    const address = users.email('verify-entry')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    const cookie = cookieHeader(signUp)
    siteverify.mockClear()

    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await s.post(
        '/send-verification-email',
        { email: address },
        { cookie, 'cf-connecting-ip': nextIp(), ...noToken },
      )
      statuses.push(res.status)
    }
    // 注册已占用该邮箱的 1 次额度
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429])
    expect(s.sent.filter((m) => m.type === 'verify-email')).toHaveLength(4)
    expect(siteverify).not.toHaveBeenCalled()
    // 未登录时同一接口要求 Turnstile
    const anonymous = await s.post('/send-verification-email', { email: address }, noToken)
    expect(anonymous.status).toBe(403)
  })

  it('Miniflare 的 RL_AUTH 绑定接入后同样拦截超限请求（与窗口边界无关）', async () => {
    const s = setup()
    const address = users.email('binding')
    const statuses: number[] = []
    // 每个 key 每窗口 5 次，11 个请求最多跨过一次窗口边界、至多放行 10 次，必然出现 429
    for (let i = 0; i < 11; i++) {
      const res = await s.post(
        '/email-otp/send-verification-otp',
        { email: address, type: 'sign-in' },
        { 'cf-connecting-ip': nextIp() },
      )
      statuses.push(res.status)
    }
    expect(statuses).toContain(429)
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true)
    expect(s.sent).toHaveLength(statuses.filter((status) => status === 200).length)
  })
})

describe('OTP 独立校验入口', () => {
  it('返回 404，既不读写验证码也不触发限流与 siteverify', async () => {
    const rateLimiter = { limit: vi.fn(async () => ({ success: true })) }
    const s = setup({ rateLimiter })
    const address = users.email('disabled-check')
    await s.auth.api.sendVerificationOTP({ body: { email: address, type: 'email-verification' } })
    const before = await s.db
      .$client`select * from verification where identifier like ${`%${address}%`}`
    const result = await s.post(
      '/email-otp/check-verification-otp',
      { email: address, type: 'email-verification', otp: '000000' },
      noToken,
    )
    expect(result.status).toBe(404)
    expect(
      await s.db.$client`select * from verification where identifier like ${`%${address}%`}`,
    ).toEqual(before)
    expect(rateLimiter.limit).not.toHaveBeenCalled()
    expect(siteverify).not.toHaveBeenCalled()
  })
})

describe('OTP 原子尝试预算（真实 Postgres）', () => {
  it.each([
    ['/email-otp/verify-email', 'email-verification'],
    ['/email-otp/reset-password', 'forget-password'],
    ['/sign-in/email-otp', 'sign-in'],
  ] as const)('%s 并发错误猜测累计只验证三次，此后正确验证码也失效', async (path, type) => {
    const s = setup({ config: { auth: { turnstile: false } }, rateLimiter: undefined })
    const email = users.email('atomic-budget')
    expect((await s.post('/sign-up/email', signUpBody(email))).status).toBe(200)
    const recreated: string[] = []
    // 不通过 HTTP 限流裁剪并发，用独立实例和真实 adapter 验证消费自身的尝试预算。
    const options = s.auth.options
    const makeAuth = () =>
      betterAuth({
        ...options,
        databaseHooks: {
          ...options.databaseHooks,
          verification: {
            create: {
              after: async (row) => {
                if (row.identifier.includes(email)) recreated.push(row.value)
              },
            },
          },
        },
      })
    const issue = makeAuth()
    await issue.api.sendVerificationOTP({ body: { email, type } })
    const mail = s.sent.find((message) => message.type === 'otp')
    if (mail?.type !== 'otp') throw new Error('OTP missing')
    const wrong = mail.otp === '000000' ? '111111' : '000000'
    recreated.length = 0
    const post = (otp: string) =>
      makeAuth().handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: 'POST',
          headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
          body: JSON.stringify({ email, otp, password: PASSWORD }),
        }),
      )
    // 每波在上一波完成后继续，既覆盖竞争又保证尝试预算真正用尽。
    for (let wave = 0; wave < 4; wave++) {
      const responses = await Promise.all(Array.from({ length: 12 }, () => post(wrong)))
      expect(
        responses.every((response) => response.status === 400 || response.status === 403),
      ).toBe(true)
    }
    expect(recreated.map((value) => Number(value.split(':').at(-1)))).toEqual([1, 2, 3])
    expect((await post(mail.otp)).status).toBe(400)
    expect(
      await s.db.$client`select id from verification where identifier like ${`%${email}%`}`,
    ).toHaveLength(0)
    expect(await findUser(s, email)).toMatchObject({ emailVerified: false })
  })
})
