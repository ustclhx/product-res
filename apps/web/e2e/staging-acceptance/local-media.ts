import { env } from 'cloudflare:workers'
import { readMediaTaskInput, type TaskMediaProvider } from '@product-res/ai'
import { type Database, file, notFound, scoped } from '@product-res/db'
import { persistMediaOutputs } from '@product-res/storage'
import { createCloudflareMediaCopier } from '@product-res/storage/cloudflare'
import { runMediaTask } from '../../../jobs/src/workflows/media-runner.ts'
import { requireFileWorkspace } from '../../src/features/files/access.ts'
import type { FileHttpDeps } from '../../src/features/files/http.ts'

type WorkflowStep = Parameters<typeof runMediaTask>[1]

const bytes = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPZkAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
)
export function localProvider(): TaskMediaProvider {
  return {
    id: 'local-mocked',
    capabilities: { synchronous: true, idempotentSubmit: true },
    async run() {
      return {
        outputs: [{ body: bytes, mime: 'image/png', width: 1, height: 1 }],
        usage: { images: 1 },
      }
    },
  }
}
// 仅独立本地 Vite 配置注入：真实创建/hold/runner/转存/结算，替代 Workflow 调度与外部服务商。
export function localWorkflow(db: Database, bucket: R2Bucket) {
  return {
    async create(input: { id?: string; params: { taskId: string } }) {
      const task = await db.query.aiTask.findFirst({
        where: (table, { eq }) => eq(table.id, input.params.taskId),
      })
      if (!task) throw notFound()
      if (task.kind !== 'video') {
        const step = {
          do: async (_name: string, options: unknown, action?: () => Promise<unknown>) => {
            const run = typeof options === 'function' ? (options as () => Promise<unknown>) : action
            if (!run) throw new Error('Missing local step action')
            return run()
          },
        } as unknown as WorkflowStep
        await runMediaTask(task.id, step, {
          db,
          provider: localProvider,
          params: async (row) => readMediaTaskInput(row).params,
          callbackOrigin: 'http://localhost',
          callbackSecret: 'local-fixture',
          persist: (row, result) =>
            persistMediaOutputs({
              db,
              storage: bucket,
              copyOutput: createCloudflareMediaCopier(bucket),
              task: row,
              result,
              limits: {
                maxFileBytes: 1024,
                storageBytes: 1024 ** 3,
                allowedMimeTypes: ['image/png'],
                allowedHosts: [],
              },
            }),
        })
      }
      return { id: task.id }
    },
    async get(id: string) {
      return { id, status: async () => ({ status: 'running' }), terminate: async () => {} }
    },
  }
}

export async function localDownload(request: Request, fileId: string, deps: FileHttpDeps) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? ''
  await requireFileWorkspace({ ...deps, workspaceId, headers: request.headers })
  const row = await scoped(deps.db, workspaceId).findById(file, fileId)
  if (row.status !== 'ready' || row.deletedAt) throw notFound()
  const object = await env.FILES.get(row.r2Key)
  if (!object) throw notFound()
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Disposition': 'attachment; filename="result.png"',
    },
  })
}
