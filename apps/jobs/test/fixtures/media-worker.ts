import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DBOS } from '@dbos-inc/dbos-sdk'
import type { NodeStorageConfig } from '@product-res/config/node'
import { createDb } from '@product-res/db'
import { createNodeJobEngine, createNodeWorkflow } from '@product-res/platform/node'
import { type AiMediaParams, createNodeMediaHandler } from '../../src/node/media.ts'
import { createNodeMediaWorkflowHttpHandler } from '../../src/node/media-http.ts'

interface Config {
  executorId: string
  ownershipDirectory: string
  storage: NodeStorageConfig
  secret: string
  crashAfter?: 'persist' | 'settle-and-notify'
}
const config: Config = JSON.parse(process.env.TEST_MEDIA_WORKER_CONFIG ?? '{}')
const databaseUrl = process.env.TEST_JOB_DATABASE_URL
if (!databaseUrl) throw new Error('Node media worker requires isolated PG')
const db = createDb(databaseUrl, { max: 3 })
const emit = (value: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    process.send?.(value, (error) =>
      error ? reject(new Error('Media fixture IPC failed')) : resolve(),
    )
  })

// 所有 Provider fetch 都在此拒绝或响应；真实 S3 SDK 使用自己的 HTTP transport。
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === 'https://queue.fal.run' && init?.method === 'POST') {
    await emit({ event: 'submit' })
    return Response.json({ request_id: 'fixture-job' })
  }
  if (url.origin === 'https://queue.fal.run' && init?.method === 'PUT') {
    await emit({ event: 'cancel' })
    return Response.json({ status: 'CANCELLATION_REQUESTED' })
  }
  if (url.href === 'https://fal.media/b-media-fixture.png') {
    await emit({ event: 'download' })
    return new Response('png', {
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    })
  }
  throw new Error('Unexpected media fixture outbound request')
}

// 在正式 step callback 已返回、DBOS 尚未记录结果时退出，保持生产步骤/重试策略不变。
const runStep = DBOS.runStep.bind(DBOS)
DBOS.runStep = async <T>(
  callback: () => Promise<T>,
  options?: Parameters<typeof DBOS.runStep>[1],
): Promise<T> =>
  runStep(async () => {
    const value = await callback()
    if (
      config.crashAfter &&
      options?.name === `workflow.do:${JSON.stringify([config.crashAfter, 0])}`
    ) {
      await emit({ event: 'before-checkpoint', step: config.crashAfter })
      process.kill(process.pid, 'SIGKILL')
      await new Promise(() => {})
    }
    return value
  }, options)

let workflow: ReturnType<typeof createNodeWorkflow<AiMediaParams>> | undefined
const engine = await createNodeJobEngine({
  database: db,
  databaseUrl,
  executorId: config.executorId,
  applicationVersion: 'b-media-recovery-v1',
  ownershipDirectory: config.ownershipDirectory,
  nativePoolMax: 3,
  shutdownTimeoutMs: 100,
  register(engine) {
    workflow = createNodeWorkflow({
      engine,
      name: 'ai-media-v1',
      handler: createNodeMediaHandler(db, {
        storage: config.storage,
        providerEnv: { FAL_KEY: 'local-fixture' },
        callbackOrigin: 'https://app.example.test',
        callbackSecret: config.secret,
      }),
    })
  },
  stopReceiving() {
    workflow?.stopReceiving()
  },
})
if (!workflow) throw new Error('Node media fixture workflow was not registered')
const handler = createNodeMediaWorkflowHttpHandler({
  workflow: { available: true, value: workflow },
  secret: config.secret,
})
const server = createServer((request, response) => {
  void handler(request, response)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
process.once('SIGTERM', () => {
  server.closeAllConnections()
  server.close()
  void engine
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
})
await emit({ event: 'ready', port: (server.address() as AddressInfo).port })
