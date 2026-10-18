import { createDataSourceSecrets } from '@product-res/config/node'
import { createMockConnector } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type { DeadLetterSink, QueueBatch, Scheduler } from '@product-res/platform'
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
 * 补齐数据源状态行、注册同步队列与每日维护。连接器由 add-source-connectors 逐个加入。
 */
export async function registerNodeDataSources(input: {
  readonly db: Database
  readonly queues: QueueRegistrar
  readonly scheduler: Scheduler
  readonly mock: boolean
}) {
  const context: DataSyncContext = {
    db: input.db,
    registry: createConnectorRegistry(input.mock ? { mock: createMockConnector() } : {}),
    secret: createDataSourceSecrets(),
  }
  await prepareDataSources(input.db, context.registry)
  input.queues.register(DATASYNC_QUEUE, (batch, sink) => consumeDataSync(batch, context, sink), {
    concurrency: 4,
  })
  registerDataSchedules(input.scheduler, context)
  return context
}
