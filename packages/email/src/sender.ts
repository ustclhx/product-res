/**
 * 邮件发送接口（docs/02-project-structure.md「外部调用」）：feature 代码与队列消费者只依赖
 * `EmailSender`，不直接调用 Resend 等第三方服务。
 */

export type EmailHeaders = Readonly<
  Partial<Record<'List-Unsubscribe' | 'List-Unsubscribe-Post', string>>
>

export interface EmailMessage {
  readonly headers?: EmailHeaders

  /** 收件人，单个地址或地址列表 */
  readonly to: string | readonly string[]
  readonly subject: string
  readonly html: string
  /** 纯文本版本，与 html 一起发送以提高送达率 */
  readonly text: string
  /** 回复地址；缺省时使用发送方的默认值 */
  readonly replyTo?: string
  /**
   * 稳定业务身份：Resend 在服务商去重窗口内使用幂等键；SMTP 生成稳定 Message-ID，仍可能重复投递。
   * 队列重试时应传入同一个值（如消息 ID），实际去重取决于所选通道。
   */
  readonly idempotencyKey?: string
}

export interface SendResult {
  /** 服务商返回的邮件 ID */
  readonly id: string
}

export interface EmailSender {
  /** 发送一封邮件；失败时抛出 `EmailSendError`。 */
  send(message: EmailMessage): Promise<SendResult>
}

/**
 * 发送失败。`retryable` 表示是否值得重试（服务商 5xx、429、网络错误），
 * 队列消费者据此决定 `retry()` 还是放弃。错误信息不包含收件人与邮件内容。
 */
export class EmailSendError extends Error {
  override readonly name = 'EmailSendError'
  /** 服务商返回的 HTTP 状态码；网络错误时为 undefined */
  readonly status: number | undefined
  readonly retryable: boolean

  constructor(message: string, options: { status?: number; retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = options.status
    this.retryable = options.retryable
  }
}

export function isEmailSendError(value: unknown): value is EmailSendError {
  return value instanceof EmailSendError
}
