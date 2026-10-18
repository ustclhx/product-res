import type { EmailTransportConfig } from '@product-res/config'
import {
  createResendSender,
  EmailSendError,
  type EmailSender,
  type EmailTemplateName,
  type EmailTemplateProps,
  isEmailSendError,
  type RenderedEmail,
  renderEmail,
} from '@product-res/email'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@product-res/email/queue'
import type { DeadLetterSink, QueueBatch, QueueMessage } from '@product-res/platform'
import { log, newRequestId, withLogContext } from '@product-res/shared/log'
import templateConfig from '../../../../template.config.ts'
import { type JobObserver, logJobObserver, withJobObserver } from '../observer.ts'

/**
 * EMAIL_QUEUE 消费者（tasks.md 3.2，specs/user-auth「认证邮件异步发送」）：
 * 校验消息 → 用 @product-res/email 渲染 → 按 `EMAIL_TRANSPORT` 发送。
 *
 * - 发送成功：确认（ack）。
 * - 可重试的失败（Resend 5xx / 429 / 网络错误）：`retry()`，按指数退避延迟重投；
 *   重投时幂等键不变，Resend 在 24 小时内去重，不会重复发送。
 * - 不可重试的失败（其余 4xx、消息格式错误、链接非法）：确认并记录告警，不再重试。
 * - CF 达到最大投递次数仍失败：确认并记录 `email.dropped` 错误日志。不使用死信队列：
 *   死信队列需要在 Cloudflare 上另建队列，而认证邮件（验证码、魔法链接）过期很快，
 *   事后重放价值不大；需要时在 wrangler.jsonc 中加 `dead_letter_queue` 并去掉这里的提前确认。
 * - Node 的有效终态失败交给注入的 DeadLetterSink；持久记录失败时不提前确认。
 *
 * 日志只记录消息 ID、模板名、投递次数与错误摘要，不记录邮件内容；
 * 只有 log 通道会记录收件人（替代真实发送，供本地开发核对）。
 * 消息带有投递时的请求 ID，处理时恢复到日志上下文；不带该字段的旧消息生成新的请求 ID。
 */

/** 首次投递 + 重试次数；与 wrangler.jsonc 中 consumer 的 `max_retries`（5）一致 */
export const EMAIL_MAX_ATTEMPTS = 6
const RETRY_BASE_DELAY_SECONDS = 30
const RETRY_MAX_DELAY_SECONDS = 15 * 60

/** 第 n 次投递失败后的重试延迟：30s、60s、120s……，最长 15 分钟 */
export function emailRetryDelaySeconds(attempts: number): number {
  return Math.min(
    RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1),
    RETRY_MAX_DELAY_SECONDS,
  )
}

/** 一次投递：发送渲染好的邮件，返回服务商的邮件 ID（log 通道为 null）。 */
type Deliver = (message: EmailQueueMessage, rendered: RenderedEmail) => Promise<string | null>

export type JobsEmailTransport = EmailTransportConfig | { readonly transport: 'smtp' }

interface EmailBatchOptions {
  observer?: JobObserver
  deadLetters?: DeadLetterSink<unknown>
  sender?: EmailSender
}

function createDeliver(transport: JobsEmailTransport, injectedSender?: EmailSender): Deliver {
  if (transport.transport === 'log') {
    return async (message) => {
      log.info('email.logged', { template: message.template, to: message.to })
      return null
    }
  }
  if (transport.transport === 'smtp' && !injectedSender) {
    throw new EmailSendError('SMTP_SENDER_UNAVAILABLE', { retryable: false })
  }
  const sender =
    injectedSender ??
    (transport.transport === 'resend'
      ? createResendSender({
          apiKey: transport.apiKey,
          from: transport.from,
          ...(transport.replyTo === undefined ? {} : { replyTo: transport.replyTo }),
        })
      : undefined)
  if (!sender) throw new EmailSendError('SMTP_SENDER_UNAVAILABLE', { retryable: false })
  return async (message, rendered) => {
    const result = await sender.send({
      to: message.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(rendered.headers ? { headers: rendered.headers } : {}),
      idempotencyKey: message.idempotencyKey,
    })
    return result.id
  }
}

function render(message: EmailQueueMessage): Promise<RenderedEmail> {
  // 联合类型下 TS 无法把 template 与 props 关联起来；parseEmailQueueMessage 已按模板校验 props
  return renderEmail(
    message.template as EmailTemplateName,
    message.props as EmailTemplateProps[EmailTemplateName],
    {
      locale: message.locale,
      appName: message.appName,
      defaultLocale: templateConfig.i18n.defaultLocale,
    },
  )
}

export async function handleEmailBatch(
  batch: QueueBatch<unknown>,
  transport: JobsEmailTransport,
  options: EmailBatchOptions = {},
): Promise<void> {
  const deliver = createDeliver(transport, options.sender)
  // 每条消息单独确认 / 重试，一条失败不影响同批的其他消息
  const results = await Promise.allSettled(
    batch.messages.map((message) => handleMessage(message, deliver, transport, options)),
  )
  // 死信持久化失败也须等其他成员完成，避免批次出口提前恢复仍在处理的消息。
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

async function handleMessage(
  message: QueueMessage<unknown>,
  deliver: Deliver,
  transport: JobsEmailTransport,
  options: EmailBatchOptions,
): Promise<void> {
  const meta = { id: message.id, attempts: message.attempts }
  const email = parseEmailQueueMessage(message.body)
  if (email === null) {
    log.warn('email.invalid', meta)
    message.ack()
    return
  }

  await withLogContext({ requestId: email.requestId ?? newRequestId() }, () =>
    withJobObserver(options.observer ?? logJobObserver, () =>
      deliverMessage(message, email, deliver, transport, options),
    ),
  )
}

async function deliverMessage(
  message: QueueMessage<unknown>,
  email: EmailQueueMessage,
  deliver: Deliver,
  transport: JobsEmailTransport,
  options: EmailBatchOptions,
): Promise<void> {
  const observer = options.observer ?? logJobObserver
  const meta = { id: message.id, attempts: message.attempts }
  const context = { ...meta, template: email.template, transport: transport.transport }
  try {
    const providerId = await deliver(email, await render(email))
    log.info('email.sent', { ...context, providerId })
    message.ack()
  } catch (error) {
    observer.captureException(error)
    const failure = describeError(error)
    if (!failure.retryable) {
      log.warn('email.failed', { ...context, ...failure })
      await finishFailure(message, failure, options.deadLetters)
    } else if (message.attempts >= EMAIL_MAX_ATTEMPTS) {
      log.error('email.dropped', { ...context, ...failure })
      await finishFailure(message, failure, options.deadLetters)
    } else {
      const delaySeconds = emailRetryDelaySeconds(message.attempts)
      log.warn('email.retry', { ...context, ...failure, delaySeconds })
      message.retry({ delaySeconds })
    }
  }
}

/**
 * 错误摘要：`EmailSendError` 的消息不含收件人与内容，可以记录；其他错误只记录类型名。
 * 渲染时链接非法（TypeError）属于消息本身的问题，重试无效；其他未知错误按暂时性失败重试。
 */
function describeError(error: unknown) {
  if (isEmailSendError(error)) {
    return { retryable: error.retryable, status: error.status, error: error.message }
  }
  const name = error instanceof Error ? error.name : typeof error
  return { retryable: !(error instanceof TypeError), error: name }
}

/** B 持久记录终态失败后才确认；CF 未装配此 hook，保留原有 drop。 */
async function finishFailure(
  message: QueueMessage<unknown>,
  failure: { retryable: boolean },
  deadLetters: DeadLetterSink<unknown> | undefined,
) {
  if (deadLetters) {
    await deadLetters.failed(message, {
      code: failure.retryable ? 'EMAIL_ATTEMPTS_EXHAUSTED' : 'EMAIL_NON_RETRYABLE',
      retryable: failure.retryable,
    })
  } else message.ack()
}
