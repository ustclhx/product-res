import { auditLog, type Subscription } from '@product-res/db'
import type { WebhookTransaction } from './pipeline.ts'

/** 只记录关键状态实际变更，忽略 raw / updatedAt 变化及幂等回放。 */
export function subscriptionAuditState(row: Subscription) {
  return {
    status: row.status,
    planPriceId: row.planPriceId,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
  }
}
export async function auditSubscriptionChange(
  tx: WebhookTransaction,
  before: Subscription | undefined,
  after: Subscription,
  source: string,
  actorUserId: string | null = null,
  ip: string | null = null,
) {
  const oldState = before ? subscriptionAuditState(before) : null
  const newState = subscriptionAuditState(after)
  if (JSON.stringify(oldState) === JSON.stringify(newState)) return
  await tx
    // 计费事务已锁定并验证目标空间，审计使用订阅的明确 workspaceId。
    .insert(auditLog)
    .values({
      actorUserId,
      workspaceId: after.workspaceId,
      action: 'billing.subscription_changed',
      targetType: 'subscription',
      targetId: after.id,
      ip,
      meta: { before: oldState, after: newState, source, provider: after.provider },
    })
}
