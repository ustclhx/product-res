import {
  type BillingQueueMessage,
  notifyRefundRequest,
  type RefundNotification,
} from '@product-res/billing'
import type { EmailQueueMessage } from '@product-res/email/queue'
import type { QueueBatch } from '@product-res/platform'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// tasks.md 1.1：结账请求投递的 EVENTS_QUEUE 消息带请求 ID（web 侧见 features/billing/webhook-http.test.ts），
// jobs 消费时恢复到日志上下文，并带到由它投递的 EMAIL_QUEUE 消息与邮件消费者的日志中。

const mocks = vi.hoisted(() => ({ postprocess: vi.fn() }))
vi.mock('../src/billing.ts', () => ({
  createBillingContext: (env: { emailQueue: unknown }) => ({ mail: env.emailQueue }),
  postprocessBillingDelivery: mocks.postprocess,
}))

import { handleBillingBatch } from '../src/queues/billing.ts'
import { handleEmailBatch } from '../src/queues/email.ts'

const deliveryId = '93f577ac-e28b-4ca3-9768-05d4e2aa5649'
const requestId = '01890a5d-ac96-774b-bcce-b302099a8057'

/** 退款结果邮件：真实的 notifyRefundRequest，数据库查询返回空（未发送过、用户语言未知） */
const refundMail = (send: (message: EmailQueueMessage) => void) => {
  const query = {
    from: () => query,
    where: () => Promise.resolve([]),
  }
  const db = {
    select: () => query,
    insert: () => ({ values: () => Promise.resolve() }),
  }
  return {
    db,
    queue: { send: async (message: EmailQueueMessage) => send(message) },
    appName: 'TestApp',
    supportEmail: 'hxl15380@gmail.com',
  } as unknown as Parameters<typeof notifyRefundRequest>[0]
}
const notification = {
  request: {
    id: 'refund-1',
    workspaceId: 'w1',
    userId: 'u1',
    status: 'approved',
    approvedAmount: 500,
    reviewNote: null,
    contactEmail: 'buyer@example.com',
  },
  contactEmail: 'buyer@example.com',
  idempotencyKey: 'refund-notification:refund-1:approved',
} as unknown as RefundNotification

function batch<T>(queue: string, bodies: T[]) {
  const messages = bodies.map((body, i) => ({
    body,
    id: `${queue}-${i + 1}`,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  return { queue, messages } as unknown as QueueBatch<unknown> & { messages: typeof messages }
}

let lines: () => Record<string, unknown>[]
beforeEach(() => {
  const spies = (['log', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  )
  lines = () => spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.parse(String(call[0]))))
  mocks.postprocess.mockImplementation(({ mail }) => notifyRefundRequest(mail, notification))
})
afterEach(() => vi.restoreAllMocks())

it('follows one checkout request ID from EVENTS_QUEUE to EMAIL_QUEUE and both consumers', async () => {
  const emails: EmailQueueMessage[] = []
  const env = { emailQueue: refundMail((message) => emails.push(message)) }
  const events = batch('product-res-events', [
    { v: 1, deliveryId, requestId } satisfies BillingQueueMessage,
  ])
  await handleBillingBatch(events, env as never)
  expect(events.messages[0]?.ack).toHaveBeenCalledOnce()

  // 由消费者投递的后续消息带同一请求 ID
  expect(emails).toHaveLength(1)
  expect(emails[0]?.requestId).toBe(requestId)
  const mails = batch('product-res-email', emails)
  await handleEmailBatch(mails, { transport: 'log' })
  expect(mails.messages[0]?.ack).toHaveBeenCalledOnce()

  expect(lines().map((line) => [line.event, line.requestId])).toEqual([
    ['billing.postprocessed', requestId],
    ['email.logged', requestId],
    ['email.sent', requestId],
  ])
})

it('still processes messages enqueued before request IDs existed, under a fresh ID', async () => {
  const emails: EmailQueueMessage[] = []
  const env = { emailQueue: refundMail((message) => emails.push(message)) }
  const events = batch('product-res-events', [{ v: 1, deliveryId }])
  await handleBillingBatch(events, env as never)
  expect(events.messages[0]?.ack).toHaveBeenCalledOnce()

  const { requestId: _, ...legacy } = emails[0] as EmailQueueMessage
  const mails = batch('product-res-email', [legacy])
  await handleEmailBatch(mails, { transport: 'log' })
  expect(mails.messages[0]?.ack).toHaveBeenCalledOnce()

  const [billing, logged] = lines()
  expect(billing?.requestId).toEqual(expect.any(String))
  // 旧邮件消息不带请求 ID：消费端生成新的，不沿用别的请求
  expect(logged?.requestId).toEqual(expect.any(String))
  expect(logged?.requestId).not.toBe(billing?.requestId)
})
