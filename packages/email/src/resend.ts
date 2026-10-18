import { type EmailMessage, EmailSendError, type EmailSender, type SendResult } from './sender.ts'

/** Resend HTTP API（https://resend.com/docs/api-reference/emails/send-email）。 */
export const RESEND_API_URL = 'https://api.resend.com/emails'

export interface ResendSenderOptions {
  /** `RESEND_API_KEY` */
  readonly apiKey: string
  /** 发件人，如 `product-res <noreply@example.com>`，域名需已在 Resend 验证 */
  readonly from: string
  /** 默认回复地址（通常为 `app.supportEmail`） */
  readonly replyTo?: string
  /** 测试时注入；默认使用全局 fetch */
  readonly fetch?: typeof fetch
  readonly endpoint?: string
}

/**
 * 用 fetch 直接调用 Resend HTTP API，不引入 SDK（Worker 中更小、也便于测试时替换 fetch）。
 */
export function createResendSender(options: ResendSenderOptions): EmailSender {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const endpoint = options.endpoint ?? RESEND_API_URL

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      const replyTo = message.replyTo ?? options.replyTo
      const mailHeaders: Record<string, string> = {}
      for (const name of ['List-Unsubscribe', 'List-Unsubscribe-Post'] as const) {
        const value = message.headers?.[name]
        if (value !== undefined) {
          if (/[\r\n]/.test(value)) throw new TypeError('Invalid email header')
          mailHeaders[name] = value
        }
      }
      const body = {
        from: options.from,
        to: typeof message.to === 'string' ? [message.to] : [...message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(Object.keys(mailHeaders).length ? { headers: mailHeaders } : {}),
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      }
      if (message.idempotencyKey !== undefined) {
        headers['idempotency-key'] = message.idempotencyKey
      }

      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
      } catch (cause) {
        throw new EmailSendError('Resend request failed', { retryable: true, cause })
      }

      if (!response.ok) {
        // 只取 Resend 错误体中的 `name`（如 validation_error），message 可能回显收件人地址
        const name = await errorName(response)
        throw new EmailSendError(
          `Resend responded ${response.status}${name === undefined ? '' : ` (${name})`}`,
          { status: response.status, retryable: isRetryableStatus(response.status) },
        )
      }

      const data = (await response.json().catch(() => null)) as { id?: unknown } | null
      if (typeof data?.id !== 'string') {
        throw new EmailSendError('Resend response has no id', {
          status: response.status,
          retryable: false,
        })
      }
      return { id: data.id }
    },
  }
}

/** 5xx 与 429 视为暂时性失败；其余 4xx（参数错误、密钥无效、域名未验证）重试也不会成功。 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

async function errorName(response: Response): Promise<string | undefined> {
  const data = (await response.json().catch(() => null)) as { name?: unknown } | null
  return typeof data?.name === 'string' && /^[a-z_]{1,64}$/.test(data.name) ? data.name : undefined
}
