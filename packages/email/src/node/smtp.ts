import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser'
import { z } from 'zod'
import { type EmailMessage, EmailSendError, type EmailSender } from '../sender.ts'

export type SmtpTlsMode = 'implicit' | 'starttls' | 'none'

export interface SmtpSenderOptions {
  readonly host: string
  readonly port: number
  readonly tlsMode: SmtpTlsMode
  readonly from: string
  readonly replyTo?: string
  readonly user?: string
  readonly password?: string
  readonly connectionTimeoutMs?: number
  readonly greetingTimeoutMs?: number
  readonly socketTimeoutMs?: number
}

const mailbox = z.email()
const HEADER_NAMES = ['List-Unsubscribe', 'List-Unsubscribe-Post'] as const

/** 仅由 Node composition 装配；不读取环境，不连接验证，不自行重试。 */
export function createSmtpSender(options: SmtpSenderOptions): EmailSender {
  const connectionTimeout = timeout(options.connectionTimeoutMs, 10_000)
  const greetingTimeout = timeout(options.greetingTimeoutMs, 10_000)
  const socketTimeout = timeout(options.socketTimeoutMs, 30_000)
  const hasAuth = options.user !== undefined || options.password !== undefined
  if (
    !validHost(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !['implicit', 'starttls', 'none'].includes(options.tlsMode) ||
    !validAddress(options.from) ||
    (options.replyTo !== undefined && !validAddress(options.replyTo)) ||
    (hasAuth &&
      (typeof options.user !== 'string' ||
        options.user.length === 0 ||
        typeof options.password !== 'string' ||
        options.password.length === 0))
  ) {
    throw new EmailSendError('SMTP_CONFIG_INVALID', { retryable: false })
  }

  const from = options.from
  const defaultReplyTo = options.replyTo
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.tlsMode === 'implicit',
    requireTLS: options.tlsMode === 'starttls',
    // none 必须显式选择，仅限受控内部中继/测试；其他模式不允许降级。
    ignoreTLS: options.tlsMode === 'none',
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    ...(hasAuth ? { auth: { user: options.user, pass: options.password } } : {}),
    forceAuth: hasAuth,
    pool: false,
    connectionTimeout,
    greetingTimeout,
    socketTimeout,
    dnsTimeout: connectionTimeout,
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  })

  return {
    async send(message: EmailMessage) {
      const replyTo = message.replyTo ?? defaultReplyTo
      const to = typeof message.to === 'string' ? [message.to] : [...message.to]
      if (
        to.length === 0 ||
        !to.every(validAddress) ||
        (replyTo !== undefined && !validAddress(replyTo)) ||
        typeof message.subject !== 'string' ||
        /[\r\n\0]/.test(message.subject) ||
        typeof message.html !== 'string' ||
        typeof message.text !== 'string' ||
        (message.idempotencyKey !== undefined &&
          (typeof message.idempotencyKey !== 'string' || message.idempotencyKey.length === 0))
      ) {
        throw new EmailSendError('SMTP_MESSAGE_INVALID', { retryable: false })
      }
      const headers: Record<string, string> = {}
      for (const name of HEADER_NAMES) {
        const value = message.headers?.[name]
        if (value === undefined) continue
        if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
          throw new EmailSendError('SMTP_MESSAGE_INVALID', { retryable: false })
        }
        headers[name] = value
      }

      try {
        const result = await transport.sendMail({
          from,
          to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(replyTo === undefined ? {} : { replyTo }),
          headers,
          // 哈希不暴露业务键/邮箱；稳定身份便于追踪，不代表 SMTP 服务器去重。
          ...(message.idempotencyKey === undefined
            ? {}
            : {
                messageId: `<${createHash('sha256')
                  .update(`${from}\0${message.idempotencyKey}`)
                  .digest('hex')}@smtp.saas.invalid>`,
              }),
        })
        // 多收件人部分拒收也不能报告整封成功；重投可能重复送达已接受的地址。
        if (result.rejected.length > 0) {
          const errors = result.rejectedErrors ?? []
          throw (
            errors.find((error) => safeSmtpError(error).retryable) ??
            errors[0] ??
            new EmailSendError('SMTP_RECIPIENT_REJECTED', { retryable: false })
          )
        }
        return { id: result.messageId }
      } catch (error) {
        throw safeSmtpError(error)
      }
    },
  }
}

function timeout(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback
  if (!Number.isInteger(ms) || ms < 100 || ms > 60_000) {
    throw new EmailSendError('SMTP_CONFIG_INVALID', { retryable: false })
  }
  return ms
}

function validHost(host: string): boolean {
  return (
    typeof host === 'string' &&
    (isIP(host) !== 0 ||
      (host.length <= 253 &&
        host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(label))))
  )
}

function validAddress(value: string): boolean {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return false
  const addresses = addressparser(value)
  return addresses.length === 1 && mailbox.safeParse(addresses[0]?.address).success
}

/** responseCode 优先于 EAUTH/EENVELOPE；外部原文/cause 不跨越 sender 边界。 */
function safeSmtpError(error: unknown): EmailSendError {
  if (error instanceof EmailSendError) return error
  const details = error as { responseCode?: unknown; code?: unknown } | null
  const status = details?.responseCode
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
    return new EmailSendError(status < 500 ? 'SMTP_TEMPORARY_FAILURE' : 'SMTP_PERMANENT_FAILURE', {
      status,
      retryable: status < 500,
    })
  }
  switch (details?.code) {
    case 'EAUTH':
    case 'ENOAUTH':
    case 'ECONFIG':
    case 'EENVELOPE':
    case 'EMAXRECIPIENTS':
    case 'EFILEACCESS':
    case 'EURLACCESS':
    case 'EMESSAGE':
      return new EmailSendError('SMTP_MESSAGE_OR_CONFIG_INVALID', { retryable: false })
    default:
      return new EmailSendError('SMTP_CONNECTION_FAILED', { retryable: true })
  }
}
