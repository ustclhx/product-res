import type { AuthEmail } from '@product-res/auth'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@product-res/email/queue'
import { describe, expect, it } from 'vitest'
import { createQueueAuthEmailSender, invitationUrl, toTemplate } from './auth-email.ts'

const APP_URL = 'https://app.example.com'

function setup(resolveLocale?: (email: string) => Promise<string | null>) {
  const sent: { body: EmailQueueMessage; options: unknown }[] = []
  const sendEmail = createQueueAuthEmailSender({
    queue: {
      send: async (body, options) => {
        sent.push({ body, options })
      },
    },
    appName: 'product-res',
    appUrl: APP_URL,
    ...(resolveLocale && { resolveLocale }),
  })
  return { sent, sendEmail }
}

describe('createQueueAuthEmailSender', () => {
  it('投递可序列化、能通过消费端校验的消息', async () => {
    const { sent, sendEmail } = setup(async () => 'zh-CN')
    await sendEmail({ type: 'reset-password', to: 'user@example.com', url: `${APP_URL}/reset` })

    expect(sent).toHaveLength(1)
    const [{ body, options }] = sent as [(typeof sent)[number]]
    // 平台契约只发送消息；CF JSON 序列化由目标 adapter/默认队列行为负责。
    expect(options).toBeUndefined()
    expect(body).toEqual({
      v: 1,
      template: 'reset-password',
      props: { url: `${APP_URL}/reset`, expiresInMinutes: 60 },
      to: 'user@example.com',
      locale: 'zh-CN',
      appName: 'product-res',
      idempotencyKey: expect.any(String),
    })
    // 经过 JSON 往返后仍是同一条合法消息
    expect(parseEmailQueueMessage(JSON.parse(JSON.stringify(body)))).toEqual(body)
  })

  it('每封邮件生成不同的幂等键；未提供语言查询时 locale 为 null', async () => {
    const { sent, sendEmail } = setup()
    const email: AuthEmail = { type: 'verify-email', to: 'a@example.com', url: `${APP_URL}/v` }
    await sendEmail(email)
    await sendEmail(email)
    const [a, b] = sent.map((s) => s.body)
    expect(a?.locale).toBeNull()
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey)
  })

  it('消息格式错误时在请求内抛错，不入队', async () => {
    const { sent, sendEmail } = setup()
    await expect(
      sendEmail({ type: 'magic-link', to: 'a@example.com', url: 'javascript:alert(1)' }),
    ).rejects.toThrow('Invalid magic-link email message')
    expect(sent).toEqual([])
  })
})

describe('toTemplate', () => {
  it.each<[AuthEmail, unknown]>([
    [
      { type: 'verify-email', to: 'a@example.com', url: 'https://x/v' },
      { template: 'verify-email', props: { url: 'https://x/v' } },
    ],
    [
      { type: 'magic-link', to: 'a@example.com', url: 'https://x/m' },
      { template: 'magic-link', props: { url: 'https://x/m', expiresInMinutes: 5 } },
    ],
    [
      { type: 'otp', to: 'a@example.com', otp: '123456', purpose: 'sign-in' },
      { template: 'otp', props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 } },
    ],
    [
      { type: 'otp', to: 'a@example.com', otp: '123456', purpose: 'change-email' },
      {
        template: 'otp',
        props: { otp: '123456', purpose: 'email-verification', expiresInMinutes: 5 },
      },
    ],
    [
      {
        type: 'invitation',
        to: 'a@example.com',
        invitationId: 'inv-1',
        workspaceName: 'Acme',
        inviterName: 'Alice',
        role: 'admin',
      },
      {
        template: 'workspace-invitation',
        props: {
          url: `${APP_URL}/accept-invitation?id=inv-1`,
          workspaceName: 'Acme',
          inviterName: 'Alice',
          role: 'admin',
          expiresInDays: 7,
        },
      },
    ],
  ])('%o', (email, expected) => {
    expect(toTemplate(email, APP_URL)).toEqual(expected)
  })

  it('不支持的邀请角色不发邮件', () => {
    const email: AuthEmail = {
      type: 'invitation',
      to: 'a@example.com',
      invitationId: 'inv-1',
      workspaceName: 'Acme',
      inviterName: 'Alice',
      role: 'unknown',
    }
    expect(() => toTemplate(email, APP_URL)).toThrow('Unsupported invitation role: unknown')
  })

  it('邀请链接对 ID 编码', () => {
    expect(invitationUrl(`${APP_URL}/`, 'a/b')).toBe(`${APP_URL}/accept-invitation?id=a%2Fb`)
  })
})
