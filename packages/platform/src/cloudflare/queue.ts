import type { Capability, QueueBatch, QueueProducer, TransactionalEnqueue } from '../index.ts'

export function createCloudflareQueue<T>(
  binding: Pick<Queue<T>, 'send' | 'sendBatch'>,
): QueueProducer<T> {
  return {
    async send(body, options) {
      await binding.send(body, options)
    },
    async sendBatch(messages) {
      await binding.sendBatch(messages)
    },
  }
}

/** 保留原消息引用与方法 receiver，逐条 ack/retry 沿用各队列配置的重试与死信策略。 */
export function createCloudflareQueueBatch<T>(batch: MessageBatch<T>): QueueBatch<T> {
  return {
    queue: batch.queue,
    messages: batch.messages,
    ackAll: () => batch.ackAll(),
    retryAll: (options) => batch.retryAll(options),
  }
}

/** CF 普通 Queue 无法参加 PG 事务，绝不能以 send 代替事务入队。 */
export function cloudflareTransactionalEnqueue<T>(): Capability<TransactionalEnqueue<T>> {
  return { available: false }
}
