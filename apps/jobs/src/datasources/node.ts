import { createDataSourceSecrets } from '@product-res/config/node'
import { createMockConnector } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type { DeadLetterSink, QueueBatch, QueueProducer, Scheduler } from '@product-res/platform'
import { createQueueDispatcher, type DailyMessage } from './plan.ts'
import {
  consumeDataSync,
  createConnectorRegistry,
  DATASYNC_QUEUE,
  type DataSyncContext,
  prepareDataSources,
  registerDataSchedules,
} from './sync.ts'

interface QueueRegistrar {
  register<T>(
    name: string,
    handler: (batch: QueueBatch<T>, sink: DeadLetterSink<T>) => Promise<void>,
    overrides?: { concurrency?: number },
  ): void
}

/**
 * Node 装配数据层（add-data-source-hub）：在 engine.register 内调用，
 * 补齐数据源状态行、注册同步队列与每日流水线（汇率 → 按方向投递采集任务 → 维护与质量检查）。
 */
export async function registerNodeDataSources(input: {
  readonly db: Database
  readonly queues: QueueRegistrar
  readonly scheduler: Scheduler
  readonly mock: boolean
  /** 同步队列的生产者（由 Node 组合入口创建）；用于每日采集任务的幂等投递 */
  readonly producer?: QueueProducer<DailyMessage['body']>
}) {
  const context: DataSyncContext = {
    db: input.db,
    registry: createConnectorRegistry(input.mock ? { mock: createMockConnector() } : {}),
    secret: createDataSourceSecrets(),
    ...(input.producer
      ? { dispatcher: createQueueDispatcher(input.db, DATASYNC_QUEUE, input.producer) }
      : {}),
  }
  await prepareDataSources(input.db, context.registry)
  input.queues.register(DATASYNC_QUEUE, (batch, sink) => consumeDataSync(batch, context, sink), {
    concurrency: 4,
  })
  registerDataSchedules(input.scheduler, context)
  return context
}
