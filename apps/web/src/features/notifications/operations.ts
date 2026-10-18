import { type Database, payment, type RefundRequest, scoped } from '@product-res/db'
import { log, withRequestId } from '@product-res/shared/log'

export interface OperationsEvent {
  event: 'payment.succeeded' | 'refund.requested' | 'webhook.failed' | 'reconciliation.failed'
  sourceId: string
  workspaceId?: string
  amount?: number
  currency?: string
}

export interface OperationsQueueMessage {
  v: 1
  operations: OperationsEvent[]
  requestId?: string
}

/** 业务已提交后仅投递队列，失败不改变业务结果；消费者独立处理外部超时。 */
export async function enqueueOperations(
  queue: { send(message: unknown, options: { contentType: 'json' }): Promise<unknown> },
  event: OperationsEvent,
) {
  try {
    await queue.send(withRequestId({ v: 1, operations: [event] }), { contentType: 'json' })
  } catch {
    log.warn('operations.enqueue_failed', { event: event.event, sourceId: event.sourceId })
  }
}

export async function enqueueRefundOperations(
  db: Database,
  queue: Parameters<typeof enqueueOperations>[0],
  request: RefundRequest,
) {
  try {
    const paid = await scoped(db, request.workspaceId).findById(payment, request.paymentId)
    await enqueueOperations(queue, {
      event: 'refund.requested',
      sourceId: request.id,
      workspaceId: request.workspaceId,
      amount: request.requestedAmount ?? paid.amount - paid.refundedAmount,
      currency: paid.currency,
    })
  } catch {
    log.warn('operations.enqueue_failed', { event: 'refund.requested', sourceId: request.id })
  }
}
