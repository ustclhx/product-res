import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { RESEND_API_URL } from '@product-res/email'
import { EMAIL_QUEUE_MESSAGE_VERSION, type EmailQueueMessage } from '@product-res/email/queue'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import worker from '../src/index.ts'
import { EMAIL_MAX_ATTEMPTS, emailRetryDelaySeconds } from '../src/queues/email.ts'

// tasks.md 3.2：EMAIL_QUEUE 消费者按 EMAIL_TRANSPORT 渲染并发送；可重试的失败交给队列重试。
// Resend 一律由 mock fetch 模拟，不发送真实邮件。

const RECIPIENT = 'someone@example.com'
const message: EmailQueueMessage = {
  v: EMAIL_QUEUE_MESSAGE_VERSION,
  template: 'reset-password',
  props: { url: 'https://app.example.com/reset?token=secret-token', expiresInMinutes: 60 },
  to: RECIPIENT,
  locale: 'zh-CN',
  appName: 'TestApp',
  idempotencyKey: 'idem-key-1',
}

const resendEnv = {
  ...env,
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_fake_test_key',
  EMAIL_FROM: 'TestApp <noreply@example.com>',
} as Cloudflare.Env

async function consume(
  bodies: unknown[],
  options: { attempts?: number; env?: Cloudflare.Env; queue?: string } = {},
) {
  const batch = createMessageBatch(
    options.queue ?? 'product-res-email',
    bodies.map((body, i) => ({
      id: `m${i + 1}`,
      timestamp: new Date(),
      attempts: options.attempts ?? 1,
      body,
    })),
  )
  await worker.queue(batch, options.env ?? env)
  return getQueueResult(batch, createExecutionContext())
}

const resendReply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: MockInstance<typeof fetch>
let logs: MockInstance[]

const logged = () => logs.flatMap((l) => l.mock.calls.flat()).join('\n')

/** getQueueResult 不返回 retry() 的 delaySeconds，从 email.retry 日志中读取 */
const retryDelays = () =>
  logs
    .flatMap((l) => l.mock.calls.flat())
    .map((line) => JSON.parse(String(line)) as { event: string; id: string; delaySeconds: number })
    .filter((e) => e.event === 'email.retry')
    .map((e) => [e.id, e.delaySeconds])

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'))
  logs = (['log', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EMAIL_QUEUE 消费者：resend 通道', () => {
  it('Resend 返回 5xx 时消息重试，重投后发送成功并确认，两次使用同一幂等键', async () => {
    fetchMock.mockResolvedValueOnce(resendReply(503, { name: 'internal_server_error' }))
    const first = await consume([message], { env: resendEnv })
    expect(first.explicitAcks).toEqual([])
    expect(first.retryMessages).toEqual([{ msgId: 'm1' }])
    expect(retryDelays()).toEqual([['m1', emailRetryDelaySeconds(1)]])

    // 队列按 retry() 重投：attempts 加一
    fetchMock.mockResolvedValueOnce(resendReply(200, { id: 'resend-email-id' }))
    const second = await consume([message], { env: resendEnv, attempts: 2 })
    expect(second.explicitAcks).toEqual(['m1'])
    expect(second.retryMessages).toEqual([])
    expect(logged()).toContain('"providerId":"resend-email-id"')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(RESEND_API_URL)
      const headers = new Headers(init?.headers)
      expect(headers.get('idempotency-key')).toBe('idem-key-1')
      expect(headers.get('authorization')).toBe('Bearer re_fake_test_key')
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ from: 'TestApp <noreply@example.com>', to: [RECIPIENT] })
      // 按收件人语言（zh-CN → zh）渲染
      expect(body.subject).toContain('TestApp')
      expect(body.html).toContain('secret-token')
      expect(body.subject).toMatch(/[一-鿿]/)
    }
    // 日志不含收件人与邮件内容
    expect(logged()).not.toContain(RECIPIENT)
    expect(logged()).not.toContain('secret-token')
  })

  it('旧消息不带 locale 时按默认语言发送并确认', async () => {
    const { locale: _locale, ...legacy } = message
    fetchMock.mockResolvedValueOnce(resendReply(200, { id: 'legacy-sent' }))
    expect((await consume([legacy], { env: resendEnv })).explicitAcks).toEqual(['m1'])
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    // 本项目默认语言为 zh（template.config.ts i18n.defaultLocale）
    expect(body.subject).toBe('重置你的 TestApp 密码')
  })

  it('网络错误与 429 同样重试，延迟按投递次数指数增长', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    expect((await consume([message], { env: resendEnv })).retryMessages).toEqual([{ msgId: 'm1' }])
    fetchMock.mockResolvedValueOnce(resendReply(429, { name: 'rate_limit_exceeded' }))
    expect((await consume([message], { env: resendEnv, attempts: 3 })).retryMessages).toEqual([
      { msgId: 'm1' },
    ])
    expect(retryDelays()).toEqual([
      ['m1', 30],
      ['m1', 120],
    ])
    expect(emailRetryDelaySeconds(EMAIL_MAX_ATTEMPTS + 10)).toBe(15 * 60)
  })

  it('不可重试的错误（4xx）确认消息、不重试，并记录告警', async () => {
    fetchMock.mockResolvedValueOnce(resendReply(422, { name: 'validation_error' }))
    const result = await consume([message], { env: resendEnv })
    expect(result.explicitAcks).toEqual(['m1'])
    expect(result.retryMessages).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logs[1]?.mock.calls.flat().join('\n')).toContain('"event":"email.failed"')
    expect(logged()).toContain('validation_error')
  })

  it('最后一次投递仍失败时确认并记录 email.dropped', async () => {
    fetchMock.mockResolvedValueOnce(resendReply(500, { name: 'internal_server_error' }))
    const result = await consume([message], { env: resendEnv, attempts: EMAIL_MAX_ATTEMPTS })
    expect(result.explicitAcks).toEqual(['m1'])
    expect(result.retryMessages).toEqual([])
    expect(logs[2]?.mock.calls.flat().join('\n')).toContain('"event":"email.dropped"')
  })

  it('同一批中各消息独立确认 / 重试', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { to } = JSON.parse(String(init?.body)) as { to: string[] }
      return to[0] === 'fail@example.com'
        ? resendReply(502, { name: 'bad_gateway' })
        : resendReply(200, { id: 'ok' })
    })
    const result = await consume([message, { ...message, to: 'fail@example.com' }], {
      env: resendEnv,
    })
    expect(result.explicitAcks).toEqual(['m1'])
    expect(result.retryMessages).toEqual([{ msgId: 'm2' }])
  })

  it('staging 队列名 email-staging 同样由邮件消费者处理', async () => {
    fetchMock.mockResolvedValueOnce(resendReply(200, { id: 'ok' }))
    const result = await consume([message], { env: resendEnv, queue: 'product-res-email-staging' })
    expect(result.explicitAcks).toEqual(['m1'])
  })

  it('production 队列名 email-production 同样由邮件消费者处理', async () => {
    fetchMock.mockResolvedValueOnce(resendReply(200, { id: 'ok' }))
    const result = await consume([message], {
      env: resendEnv,
      queue: 'product-res-email-production',
    })
    expect(result.explicitAcks).toEqual(['m1'])
  })

  it('缺少 Resend 变量时拒绝处理，错误只含变量名', async () => {
    const broken = { ...env, EMAIL_TRANSPORT: 'resend' } as Cloudflare.Env
    await expect(consume([message], { env: broken })).rejects.toThrow(
      'Invalid environment: missing EMAIL_FROM, RESEND_API_KEY',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('EMAIL_QUEUE 消费者：log 通道（默认）', () => {
  it('不调用外部服务，只记录收件人与模板名', async () => {
    const result = await consume([message])
    expect(result.explicitAcks).toEqual(['m1'])
    expect(fetchMock).not.toHaveBeenCalled()

    const output = logged()
    expect(output).toContain('"event":"email.logged"')
    expect(output).toContain('"template":"reset-password"')
    expect(output).toContain(RECIPIENT)
    expect(output).not.toContain('secret-token')
    expect(output).not.toContain('TestApp')
  })
})

describe('EMAIL_QUEUE 消费者：消息校验', () => {
  it('格式错误的消息直接确认并告警，不发送、不记录消息体', async () => {
    const result = await consume(
      [
        { type: 'debug', to: 'leak@example.com' },
        { ...message, template: 'unknown' },
      ],
      { env: resendEnv },
    )
    expect(result.explicitAcks).toEqual(['m1', 'm2'])
    expect(result.retryMessages).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logged()).toContain('"event":"email.invalid"')
    expect(logged()).not.toContain('leak@example.com')
  })
})
