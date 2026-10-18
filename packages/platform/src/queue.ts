import type { Database } from '@product-res/db'

/** 使用现有 Drizzle 事务，不对业务暴露引擎或第二条连接。 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface QueueSendOptions {
  delaySeconds?: number
}
export interface QueueProducer<T> {
  send(body: T, options?: QueueSendOptions): Promise<void>
  sendBatch(messages: readonly { body: T; delaySeconds?: number }[]): Promise<void>
}

/** 与普通 send 独立：B 以同一事务或 outbox 保证回滚不投递。 */
export interface TransactionalEnqueue<T> {
  enqueue(tx: DatabaseTransaction, body: T): Promise<void>
}

export interface QueueMessage<T> {
  readonly id: string
  readonly body: T
  readonly attempts: number
  readonly timestamp: Date
  ack(): void
  retry(options?: QueueSendOptions): void
}
export interface QueueBatch<T> {
  readonly queue: string
  readonly messages: readonly QueueMessage<T>[]
  ackAll(): void
  retryAll(options?: QueueSendOptions): void
}

/** 消费者可向 B 报告有效消息终态失败；成功/无效消息才直接 ack。 */
export interface QueueFailure {
  readonly code: string
  readonly retryable: boolean
}
export interface DeadLetterSink<T> {
  /** 持久记录完成后才确认消息；CF 保留既有 ack/drop，不装配此 hook。 */
  failed(message: QueueMessage<T>, failure: QueueFailure): Promise<void>
}
