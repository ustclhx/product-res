import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { TemplateConfig } from '@product-res/config'
import { type NodeEnv, nodeEmailTransportConfig, nodeStorageConfig } from '@product-res/config/node'
import { createDb, pingDatabase } from '@product-res/db'
import {
  createNodeBackgroundTasks,
  createNodeCache,
  createNodeJobEngine,
  createNodeQueueAdapter,
  createNodeQueueProducer,
  createNodeScheduler,
  createNodeTaskHealth,
  createNodeTaskHealthResponse,
  createNodeWorkflow,
  type NodeJobEngine,
} from '@product-res/platform/node'
import { log, newRequestId, withLogContext } from '@product-res/shared/log'
import { createNodeStorage } from '@product-res/storage/node'
import templateConfig from '../../../../template.config.ts'
import { registerNodeDataSources } from '../datasources/node.ts'
import { DATASYNC_QUEUE } from '../datasources/sync.ts'
import { consumeJobsBatch, type JobsContext } from '../handlers.ts'
import { type JobObserver, logJobObserver } from '../observer.ts'
import { pausePipelineSchedules } from '../pipeline-pause.ts'
import { registerSelectionReview } from '../review/selection-review.ts'
import { registerNodeSelection } from '../selection/node.ts'
import { createNodeMediaHandler } from './media.ts'
import { createNodeMediaWorkflowHttpHandler } from './media-http.ts'
import { getNodeJobFeatures, registerNodeJobsSchedules } from './registration.ts'

export interface NodeJobsOptions {
  host: string
  port: number
  executorId: string
  ownershipDirectory: string
  applicationVersion: string
  nativePoolMax?: number
  template?: TemplateConfig
  observer?: JobObserver
}

/** 先完成持久注册，再 launch/start；业务与 native 池由同一停机流程按顺序关闭。 */
export async function startNodeJobs(config: NodeEnv, options: NodeJobsOptions) {
  // 显式通道及存储配置必须在业务连接池创建前完成校验，SMTP 不会跨通道回退。
  const emailTransport = nodeEmailTransportConfig(config)
  const storageConfig = nodeStorageConfig(config)
  const storage = storageConfig ? createNodeStorage(storageConfig) : undefined
  const emailSender =
    emailTransport.transport === 'smtp'
      ? (await import('@product-res/email/node')).createSmtpSender(emailTransport)
      : undefined
  const observer = options.observer ?? logJobObserver
  const background = createNodeBackgroundTasks()
  const db = createDb(config.DATABASE_URL, { max: config.DB_POOL_MAX })
  let cache: Awaited<ReturnType<typeof createNodeCache>>
  try {
    cache = await createNodeCache({ url: config.VALKEY_URL, namespace: config.CACHE_NAMESPACE })
  } catch (error) {
    await db.close()
    throw error
  }
  let queues!: ReturnType<typeof createNodeQueueAdapter>
  let scheduler!: ReturnType<typeof createNodeScheduler>
  let mediaWorkflow:
    | ReturnType<typeof createNodeWorkflow<{ taskId: string; requestId?: string }>>
    | undefined
  let dispose = () => {}
  let engine: NodeJobEngine
  const template = options.template ?? templateConfig
  const features = getNodeJobFeatures(template)
  const context: JobsContext = {
    config: {
      ...(config.PAYMENT_MODE === undefined ? {} : { PAYMENT_MODE: config.PAYMENT_MODE }),
      ...(config.AI_FAULT_INJECTION === undefined
        ? {}
        : { AI_FAULT_INJECTION: config.AI_FAULT_INJECTION }),
      ...(config.SENTRY_ENVIRONMENT === undefined
        ? {}
        : { SENTRY_ENVIRONMENT: config.SENTRY_ENVIRONMENT }),
      ...(config.STRIPE_SECRET_KEY === undefined
        ? {}
        : { STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY }),
      ...(config.STRIPE_WEBHOOK_SECRET === undefined
        ? {}
        : { STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET }),
      ...(config.PAYPAL_CLIENT_ID === undefined
        ? {}
        : { PAYPAL_CLIENT_ID: config.PAYPAL_CLIENT_ID }),
      ...(config.PAYPAL_CLIENT_SECRET === undefined
        ? {}
        : { PAYPAL_CLIENT_SECRET: config.PAYPAL_CLIENT_SECRET }),
      ...(config.PAYPAL_WEBHOOK_ID === undefined
        ? {}
        : { PAYPAL_WEBHOOK_ID: config.PAYPAL_WEBHOOK_ID }),
    },
    db: { business: () => db, public: () => db },
    cache: cache.kv('auth'),
    emailQueue: createNodeQueueProducer(db, 'product-res-email').producer,
    eventsQueue: createNodeQueueProducer(db, 'product-res-events').producer,
    emailTransport,
    ...(emailSender && { emailSender }),
    files: storage
      ? {
          available: true,
          value: {
            async delete(keys) {
              // Cleanup 的批量形状保持原样；Storage 每次只接受一个 key。
              for (const key of typeof keys === 'string' ? [keys] : keys) await storage.delete(key)
            },
          },
        }
      : { available: false },
    observer,
    billingEnabled: features.billing,
  }
  try {
    engine = await createNodeJobEngine({
      database: db,
      databaseUrl: config.DATABASE_URL,
      executorId: options.executorId,
      applicationVersion: options.applicationVersion,
      ownershipDirectory: options.ownershipDirectory,
      ...(options.nativePoolMax === undefined ? {} : { nativePoolMax: options.nativePoolMax }),
      shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
      async register(engine) {
        queues = createNodeQueueAdapter({
          db,
          executorId: engine.executorId,
          ownershipToken: engine.ownershipToken,
          assertOwnership: () => engine.assertOwnership(),
          isExecutorStopped: (id, token) => engine.isExecutorStopped(id, token),
        })
        queues.register('product-res-email', (batch, sink) =>
          consumeJobsBatch(batch, { ...context, emailDeadLetters: sink }),
        )
        queues.register('product-res-events', (batch, sink) =>
          consumeJobsBatch(batch, { ...context, eventsDeadLetters: sink }),
        )
        if (features.media && storageConfig && config.MEDIA_WEBHOOK_SECRET) {
          mediaWorkflow = createNodeWorkflow({
            engine,
            name: 'ai-media-v1',
            handler: createNodeMediaHandler(engine.database, {
              storage: storageConfig,
              providerEnv: {
                ...(config.FAL_KEY === undefined ? {} : { FAL_KEY: config.FAL_KEY }),
              },
              callbackOrigin: config.APP_URL,
              callbackSecret: config.MEDIA_WEBHOOK_SECRET,
              template,
              observer,
            }),
          })
        }
        scheduler = createNodeScheduler({ engine })
        dispose = registerNodeJobsSchedules(scheduler, context, template)
        // 数据源凭据验收前可暂停数据 / 选品定时流水线（计划仍注册，到点直接返回）
        const pipelineScheduler = pausePipelineSchedules(
          scheduler,
          config.DATA_PIPELINE_SCHEDULES === 'paused',
        )
        // 数据层（add-data-source-hub）：同步队列与每日维护
        const dataSync = await registerNodeDataSources({
          db,
          queues,
          scheduler: pipelineScheduler,
          mock: config.DATASOURCE_MOCK === 'true',
          producer: createNodeQueueProducer(db, DATASYNC_QUEUE).producer,
        })
        // 跟卖选品（add-follow-selection）：每日 04:00 SGT 归并、打分并生成线索；
        // 影子验证（add-shadow-validation）：05:00 打标签、周一 05:30 重算准备度、Keepa 回放队列
        registerNodeSelection({ db, scheduler: pipelineScheduler, queues, dataSync })
        registerSelectionReview(pipelineScheduler, db)
        await queues.prepare()
        await scheduler.prepare()
      },
      start() {
        queues.start()
        scheduler.start()
      },
      stopReceiving() {
        mediaWorkflow?.stopReceiving()
        queues?.stopReceiving()
        scheduler?.stopReceiving()
      },
    })
  } catch (error) {
    dispose()
    await Promise.all([cache.close(), db.close()])
    throw error
  }
  const health = createNodeTaskHealth({ queue: queues, scheduler })
  const taskResponse = createNodeTaskHealthResponse(health, { version: options.applicationVersion })
  async function dependencyAvailable(probe: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve()
          .then(probe)
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000)
        }),
      ])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
  async function readiness() {
    const [response, probes] = await Promise.all([
      taskResponse(),
      Promise.all([
        dependencyAvailable(() => pingDatabase(db)),
        dependencyAvailable(() => cache.ping()),
      ]),
    ])
    const body = (await response.json()) as Record<string, unknown>
    const [databaseUp, cacheUp] = probes
    const ready = response.ok && databaseUp && cacheUp
    return Response.json(
      {
        ...body,
        status: ready ? 'ok' : 'error',
        db: { status: databaseUp ? 'up' : 'down' },
        cache: { status: cacheUp ? 'up' : 'down' },
      },
      { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    )
  }
  const mediaHttp = createNodeMediaWorkflowHttpHandler({
    workflow: mediaWorkflow ? { available: true, value: mediaWorkflow } : { available: false },
    secret: config.MEDIA_WEBHOOK_SECRET ?? '',
  })
  const sockets = new Set<Socket>()
  let stopping = false
  const server = createServer((request, response) => {
    const release = background.beginRequest()
    response.once('finish', release)
    response.once('close', release)
    withLogContext({ requestId: newRequestId() }, () => {
      response.setHeader('cache-control', 'no-store')
      if (stopping) response.writeHead(503).end()
      else if (request.method === 'GET' && request.url === '/internal/live') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'ok', version: options.applicationVersion }))
      } else if (request.method === 'GET' && request.url === '/internal/ready') {
        background.waitUntil(
          readiness().then(async (result) => {
            response.setHeader('content-type', 'application/json')
            response.writeHead(result.status).end(await result.text())
          }),
        )
      } else if (request.url === '/internal/workflows/ai-media') {
        background.waitUntil(mediaHttp(request, response))
      } else response.writeHead(404).end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.requestTimeout = 5_000
  let shutdownDeadline: number | undefined
  async function closeObserver() {
    if (!observer.close || shutdownDeadline === undefined) return
    const remaining = Math.max(0, shutdownDeadline - Date.now())
    // SDK 的 close(0) 表示无限等待；没有预算时不能调用，也不能再分配第二个 deadline。
    if (remaining === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        observer.close(remaining),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining)
        }),
      ])
    } catch {
      log.warn('jobs.node.observer_close_failed')
    } finally {
      clearTimeout(timer)
    }
  }
  async function closeResources() {
    try {
      await engine.close()
    } finally {
      dispose()
      await Promise.all([cache.close(), db.close()])
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await closeResources()
    throw error
  }
  let shutdown: ReturnType<typeof background.shutdown> | undefined
  return {
    server,
    background,
    db,
    cache,
    engine,
    queues,
    scheduler,
    tasks: { health },
    readiness,
    shutdown() {
      shutdownDeadline ??= Date.now() + config.SHUTDOWN_TIMEOUT_MS
      shutdown ??= background
        .shutdown({
          timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
          stopReceiving() {
            stopping = true
            server.close()
            engine.stopReceiving()
            // native 排空与 HTTP 排空共用 deadline；业务池只能在 engine 完成关闭后释放。
            background.waitUntil(engine.close())
          },
          closeResources,
        })
        .then(async (result) => {
          // 业务资源结果由 A 决定；监控单独使用同一 deadline 的余量，失败不改退出结果。
          await closeObserver()
          for (const socket of sockets) socket.destroy()
          log.info('jobs.node.stopped', { ...result })
          return result
        })
      return shutdown
    },
  }
}
