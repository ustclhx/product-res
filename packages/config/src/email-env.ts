import { z } from 'zod'

/**
 * 邮件发送通道的环境变量（apps/jobs 的 EMAIL_QUEUE 消费者，docs/07-infrastructure.md §4）：
 * - `EMAIL_TRANSPORT=log`（默认）：不调用外部服务，只记录收件人与模板名；没有 Resend 凭据时使用；
 * - `EMAIL_TRANSPORT=resend`：经 Resend 发送，此时 `RESEND_API_KEY` 与 `EMAIL_FROM` 必填。
 */
export const EMAIL_TRANSPORTS = ['log', 'resend'] as const
export type EmailTransport = (typeof EMAIL_TRANSPORTS)[number]

export const emailEnvShape = {
  EMAIL_TRANSPORT: z.enum(EMAIL_TRANSPORTS).default('log'),
  /** Secret */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** 发件人，如 `product-res <noreply@example.com>`，域名需已在 Resend 验证 */
  EMAIL_FROM: z.string().min(1).optional(),
  /** 默认回复地址（通常为 `app.supportEmail`） */
  EMAIL_REPLY_TO: z.email().optional(),
}

type EmailEnvShape = typeof emailEnvShape

/**
 * 在 app 的 env schema 上加入邮件通道变量；`resend` 通道缺少必填变量时，
 * 由 `loadEnv` 按变量名报告（不含取值）。
 */
export function withEmailEnv<Shape extends z.core.$ZodShape>(schema: z.ZodObject<Shape>) {
  return schema.extend(emailEnvShape).superRefine((env, ctx) => {
    // 泛型 Shape 下 TS 无法展开合并后的输出类型，这里只读取本函数加入的字段
    const values = env as z.output<z.ZodObject<EmailEnvShape>>
    if (values.EMAIL_TRANSPORT !== 'resend') return
    for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
      if (values[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required' })
      }
    }
  })
}

export type EmailTransportConfig =
  | { readonly transport: 'log' }
  | {
      readonly transport: 'resend'
      readonly apiKey: string
      readonly from: string
      readonly replyTo: string | undefined
    }

/** 把已校验的 env 收窄为发送通道配置。 */
export function emailTransportConfig(
  env: z.output<z.ZodObject<EmailEnvShape>>,
): EmailTransportConfig {
  if (env.EMAIL_TRANSPORT === 'log') return { transport: 'log' }
  if (env.RESEND_API_KEY === undefined || env.EMAIL_FROM === undefined) {
    // withEmailEnv 已校验；直接传入未校验的对象时才会走到这里
    throw new TypeError('EMAIL_TRANSPORT=resend requires RESEND_API_KEY and EMAIL_FROM')
  }
  return {
    transport: 'resend',
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO,
  }
}
