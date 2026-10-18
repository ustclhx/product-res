import { auditLog, type Database, refundRequest, user } from '@product-res/db'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@product-res/email/queue'
import type { QueueProducer } from '@product-res/platform'
import { withRequestId } from '@product-res/shared/log'
import { and, asc, eq, isNotNull, ne, notExists, sql } from 'drizzle-orm'
import type { RefundNotification } from './refunds.ts'

export interface RefundMailOptions {
  db: Database
  queue: Pick<QueueProducer<EmailQueueMessage>, 'send'>
  appName: string
  supportEmail: string
}
const action = (status: string) => `billing.refund_email.${status}.queued`

/** Reviewed requests themselves are durable pending work; markers are written after queue acceptance. */
export async function notifyRefundRequest(
  options: RefundMailOptions,
  notification: RefundNotification,
) {
  const { request } = notification
  if (request.status === 'pending' || !request.contactEmail) return
  const [sent] = await options.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, request.id), eq(auditLog.action, action(request.status))))
  if (sent) return
  const [applicant] = await options.db
    .select({ locale: user.locale })
    .from(user)
    .where(eq(user.id, request.userId))
  const message = parseEmailQueueMessage({
    v: 1,
    template: 'refund-update',
    to: request.contactEmail,
    locale: applicant?.locale ?? null,
    appName: options.appName,
    idempotencyKey: `refund-notification:${request.id}:${request.status}`,
    props: {
      status: request.status,
      amount: request.approvedAmount,
      currency: 'USD',
      note: request.reviewNote ?? '',
      supportEmail: options.supportEmail,
    },
  })
  if (!message) throw new Error('Invalid refund notification')
  await options.queue.send(withRequestId(message))
  await options.db.insert(auditLog).values({
    workspaceId: request.workspaceId,
    action: action(request.status),
    targetType: 'refund_request',
    targetId: request.id,
  })
}

/** Recover crashes between the saved review/settlement and notification; never move money. */
export async function flushRefundNotifications(
  options: RefundMailOptions,
  input: { requestId?: string } = {},
) {
  const rows = await options.db
    .select()
    .from(refundRequest)
    .where(
      and(
        ne(refundRequest.status, 'pending'),
        input.requestId ? eq(refundRequest.id, input.requestId) : undefined,
        isNotNull(refundRequest.contactEmail),
        notExists(
          options.db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.targetId, sql`${refundRequest.id}::text`),
                eq(
                  auditLog.action,
                  sql`'billing.refund_email.' || ${refundRequest.status} || '.queued'`,
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(refundRequest.updatedAt), asc(refundRequest.id))
    .limit(100)
  let queued = 0
  const failures: string[] = []
  for (const request of rows) {
    try {
      await notifyRefundRequest(options, {
        request,
        contactEmail: request.contactEmail as string,
        idempotencyKey: `refund-notification:${request.id}:${request.status}`,
      })
      queued++
    } catch {
      failures.push(request.id)
      await options.db.insert(auditLog).values({
        workspaceId: request.workspaceId,
        action: 'billing.refund_email.failed',
        targetType: 'refund_request',
        targetId: request.id,
      })
    }
  }
  return { queued, failures }
}
