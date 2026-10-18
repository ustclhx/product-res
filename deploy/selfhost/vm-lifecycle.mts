import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createDb } from '../../packages/db/src/index.ts'
import { createNodeJobEngine } from '../../packages/platform/src/node/job-engine.ts'
import { createNodeWorkflow } from '../../packages/platform/src/node/workflow.ts'
import type { Workflow } from '../../packages/platform/src/workflow.ts'

// 仅隔离 VM 的可控任务，复用正式迁移镜像中的同版本依赖，所有连接值只从文件读取。
const require = createRequire(new URL('../../packages/platform/package.json', import.meta.url))
const { sql } = require('drizzle-orm')
const url = (await readFile('/run/secrets/app_database_url', 'utf8')).trim()
const db = createDb(url, { max: 3 })
// biome-ignore lint/suspicious/noUndeclaredEnvVars: VM直接运行夹具，不经Turbo缓存。
const executorId = process.env.PROBE_EXECUTOR_ID ?? 'd-vm-probe'
let workflow: Workflow<{ key: string }>
const engine = await createNodeJobEngine({
  database: db,
  databaseUrl: url,
  executorId,
  applicationVersion: `${executorId}-v1`,
  ownershipDirectory: '/owners',
  nativePoolMax: 3,
  shutdownTimeoutMs: 1000,
  register(engine) {
    workflow = createNodeWorkflow({
      engine,
      name: `${executorId}-v1`,
      async handler({ key }: { key: string }, step) {
        await step.do('prepared', async () => {
          await db.execute(sql`INSERT INTO public.d_vm_effect(key,prepared,completed)
            VALUES(${key},1,0) ON CONFLICT(key) DO UPDATE SET prepared=d_vm_effect.prepared+1`)
          return { prepared: true }
        })
        await step.sleep('original-sleep', 10_000)
        const event = await step.waitForEvent('original-deadline', {
          type: 'resume',
          timeoutMs: 600_000,
        })
        await step.do('completed', async () => {
          await db.execute(
            sql`UPDATE public.d_vm_effect SET completed=completed+1 WHERE key=${key}`,
          )
          return null
        })
        return { resumed: event.payload === 'continue' }
      },
    })
  },
})
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader('Content-Type', 'application/json')
    const path = request.url ?? ''
    const key = path.split('/')[2]
    if (path === '/ready') {
      response.end(JSON.stringify({ ready: true }))
      return
    }
    if (path === '/close') {
      await engine.close()
      response.end(JSON.stringify({ closed: true, processStillAlive: true }))
      return
    }
    if (!key || !/^[a-z-]+$/.test(key)) throw new Error('Invalid fixture key')
    if (path.startsWith('/start/')) await workflow.create({ id: key, params: { key } })
    else if (path.startsWith('/resume/'))
      await (await workflow.get(key)).sendEvent({ type: 'resume', payload: 'continue' })
    else if (path.startsWith('/status/')) {
      const rows = await db.execute(
        sql`SELECT prepared,completed FROM public.d_vm_effect WHERE key=${key}`,
      )
      response.end(JSON.stringify({ state: await (await workflow.get(key)).status(), rows }))
      return
    } else throw new Error('Unknown fixture operation')
    response.end(JSON.stringify({ accepted: true }))
  })().catch(() => {
    response.statusCode = 500
    response.end(JSON.stringify({ failed: true }))
  })
})
server.listen(3101, '127.0.0.1')
process.once('SIGTERM', () => {
  void engine
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
})
console.info(JSON.stringify({ event: 'd-vm.lifecycle.ready' }))
