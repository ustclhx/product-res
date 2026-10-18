import type { AuthEmail, SendAuthEmail } from '@product-res/auth'
import type { Database } from '@product-res/db'
import {
  EMAIL_QUEUE_MESSAGE_VERSION,
  type EmailQueueMessage,
  type EmailTemplateName,
  type EmailTemplateProps,
  parseEmailQueueMessage,
} from '@product-res/email/queue'
import type { QueueProducer } from '@product-res/platform'
import { newId } from '@product-res/shared'
import { withRequestId } from '@product-res/shared/log'

/**
 * 认证邮件的发送函数（tasks.md 3.2）：把 `createAuth` 发出的 `AuthEmail` 转成 EMAIL_QUEUE 消息，
 * 由 apps/jobs 渲染并发送。用户请求只等待入队，不受邮件服务可用性影响
 * （specs/user-auth「认证邮件异步发送」）；发送失败由队列重试。
 *
 * 接线（/api/auth 挂载处）：
 * ```ts
 * createAuth(env, db, {
 *   config,
 *   sendEmail: createQueueAuthEmailSender({
 *     queue: env.EMAIL_QUEUE,
 *     appName: config.app.name,
 *     appUrl: env.APP_URL,
 *     resolveLocale: userLocaleByEmail(db),
 *   }),
 * })
 * ```
 */

/** 邮件文案中的有效期，与认证后端一致 */
export const AUTH_EMAIL_EXPIRY = {
  /** emailOTP 插件 `expiresIn` 默认 300 秒 */
  otpMinutes: 5,
  /** magicLink 插件 `expiresIn` 默认 300 秒 */
  magicLinkMinutes: 5,
  /** `emailAndPassword.resetPasswordTokenExpiresIn` 默认 3600 秒 */
  resetPasswordMinutes: 60,
  /** 自定义团队后端 team-workspaces.ts 的邀请有效期为 7 天 */
  invitationDays: 7,
} as const

/** 接受邀请页面的地址（页面在 tasks.md 4.5 实现） */
export function invitationUrl(appUrl: string, invitationId: string): string {
  const url = new URL('/accept-invitation', appUrl)
  url.searchParams.set('id', invitationId)
  return url.toString()
}

export interface QueueAuthEmailSenderOptions {
  /** `env.EMAIL_QUEUE`（测试中可传入记录消息的假实现） */
  readonly queue: Pick<QueueProducer<EmailQueueMessage>, 'send'>
  /** `template.config.ts` 的 `app.name`，随消息带给消费者用于渲染 */
  readonly appName: string
  /** `APP_URL`，用于拼接邀请链接 */
  readonly appUrl: string
  /** 按收件人邮箱查语言（`user.locale`）；不提供或查不到时用默认语言 */
  readonly resolveLocale?: (email: string) => Promise<string | null | undefined>
}

export function createQueueAuthEmailSender(options: QueueAuthEmailSenderOptions): SendAuthEmail {
  return async (email) => {
    const { template, props } = toTemplate(email, options.appUrl)
    const locale = (await options.resolveLocale?.(email.to)) ?? null
    const message = {
      v: EMAIL_QUEUE_MESSAGE_VERSION,
      template,
      props,
      to: email.to,
      locale,
      appName: options.appName,
      // 入队时生成，重试时不变：服务商据此去重
      idempotencyKey: newId(),
    } as EmailQueueMessage
    // 入队前按消费者的规则校验，格式错误在请求内暴露，而不是在队列里被静默丢弃
    if (parseEmailQueueMessage(message) === null) {
      throw new TypeError(`Invalid ${template} email message`)
    }
    await options.queue.send(withRequestId(message))
  }
}

type TemplateMessage = {
  [N in EmailTemplateName]: { template: N; props: EmailTemplateProps[N] }
}[EmailTemplateName]

/** `AuthEmail` → 模板名与 props */
export function toTemplate(email: AuthEmail, appUrl: string): TemplateMessage {
  switch (email.type) {
    case 'verify-email':
      return { template: 'verify-email', props: { url: email.url } }
    case 'reset-password':
      return {
        template: 'reset-password',
        props: { url: email.url, expiresInMinutes: AUTH_EMAIL_EXPIRY.resetPasswordMinutes },
      }
    case 'magic-link':
      return {
        template: 'magic-link',
        props: { url: email.url, expiresInMinutes: AUTH_EMAIL_EXPIRY.magicLinkMinutes },
      }
    case 'otp':
      return {
        template: 'otp',
        props: {
          otp: email.otp,
          // 更换邮箱的验证码发往新地址，用途等同于验证邮箱
          purpose: email.purpose === 'change-email' ? 'email-verification' : email.purpose,
          expiresInMinutes: AUTH_EMAIL_EXPIRY.otpMinutes,
        },
      }
    case 'invitation': {
      // 与自定义团队后端支持的角色一致；未知角色不发邀请邮件
      if (email.role !== 'owner' && email.role !== 'admin' && email.role !== 'member') {
        throw new TypeError(`Unsupported invitation role: ${email.role}`)
      }
      return {
        template: 'workspace-invitation',
        props: {
          url: invitationUrl(appUrl, email.invitationId),
          workspaceName: email.workspaceName,
          inviterName: email.inviterName,
          role: email.role,
          expiresInDays: AUTH_EMAIL_EXPIRY.invitationDays,
        },
      }
    }
  }
}

/** 按邮箱查已注册用户的 `user.locale`；未注册（如被邀请人）返回 null。 */
export function userLocaleByEmail(db: Database) {
  return async (email: string): Promise<string | null> => {
    const row = await db.query.user.findFirst({
      columns: { locale: true },
      // Better Auth 存储小写邮箱
      where: (user, { eq }) => eq(user.email, email.toLowerCase()),
    })
    return row?.locale ?? null
  }
}
