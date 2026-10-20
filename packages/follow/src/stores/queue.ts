/**
 * 手动触发“立即跑一轮店铺追踪”（tasks 5.1 暂停流水线时的验收入口）：web 投递消息，
 * apps/jobs 的店铺追踪队列消费者执行一轮（只限发起的空间，忽略周期，采集任务仍经同步队列与额度账本）。
 */
export const STORE_TRACKING_QUEUE = 'product-res-store-tracking'

export interface StoreRoundMessage {
  readonly v: 1
  readonly type: 'store-tracking-round'
  readonly workspaceId: string
  readonly requestedAt: string
  /** 同一空间每小时最多一轮 */
  readonly idempotencyKey: string
}

export function isStoreRoundMessage(body: unknown): body is StoreRoundMessage {
  const value = body as Partial<StoreRoundMessage> | null
  return (
    value?.v === 1 &&
    value.type === 'store-tracking-round' &&
    typeof value.workspaceId === 'string' &&
    typeof value.requestedAt === 'string'
  )
}

/** 每小时一个幂等键：重复点击不重复投递 */
export function storeRoundKey(workspaceId: string, at: Date) {
  return `store-tracking:manual:${workspaceId}:${at.toISOString().slice(0, 13)}`
}
