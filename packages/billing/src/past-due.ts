import type { Subscription } from '@product-res/db'

type SubscriptionStatus = Subscription['status']

// PayPal 扣款失败后的挂起（paused）同属欠费链路，沿用首次欠费时间。
const delinquent: readonly SubscriptionStatus[] = ['past_due', 'paused']

/**
 * 欠费开始时间取本次进入欠费的首个时间点：保持欠费期间的订阅更新、每日对账与扣款重试
 * 都不清空或推后它（Stripe 快照没有欠费时间，不能直接覆盖）；离开欠费状态时清空。
 */
export function nextPastDueSince(
  current: Date | null,
  nextStatus: SubscriptionStatus,
  eventTime: Date,
): Date | null {
  if (!delinquent.includes(nextStatus)) return null
  return current ?? eventTime
}
