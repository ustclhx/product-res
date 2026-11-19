import { z } from 'zod'

const taskFile = z.object({
  id: z.uuid(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  downloadUrl: z.string(),
})
const taskSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  userId: z.uuid(),
  kind: z.enum(['image', 'video']),
  modelKey: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime(),
  creditsCharged: z.number().int().nonnegative().nullable(),
  cancelBilling: z.enum(['free_unstarted', 'free_started', 'charged']).nullable().default(null),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  files: z.array(taskFile),
  canCancel: z.boolean(),
})
const listSchema = z.object({ items: z.array(taskSchema), nextCursor: z.uuid().nullable() })
export type MediaTask = z.infer<typeof taskSchema>
export type MediaTaskPage = z.infer<typeof listSchema>
export type MediaTaskFile = z.infer<typeof taskFile>

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, cache: 'no-store' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(body)
    throw new Error(error.success ? error.data.error.code : 'MEDIA_REQUEST_FAILED')
  }
  return body
}

export async function listMediaTasks(workspaceId: string, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ workspaceId, limit: '30' })
  if (cursor) query.set('cursor', cursor)
  return listSchema.parse(await requestJson(`/api/ai/tasks?${query}`, signal ? { signal } : {}))
}

export async function getMediaTask(workspaceId: string, taskId: string, signal: AbortSignal) {
  const query = new URLSearchParams({ workspaceId })
  return z
    .object({ task: taskSchema })
    .parse(await requestJson(`/api/ai/tasks/${encodeURIComponent(taskId)}?${query}`, { signal }))
    .task
}

const cancelPreviewSchema = z.object({
  taskId: z.uuid(),
  cancelable: z.boolean(),
  started: z.boolean(),
  charged: z.boolean(),
  credits: z.number().int().nonnegative(),
  freeStartedRemaining: z.number().int().nonnegative(),
})
export type MediaCancelPreview = z.infer<typeof cancelPreviewSchema>

/** 只读预览本次取消是否计费；执行取消时服务端会重新判断。 */
export async function previewMediaCancel(workspaceId: string, taskId: string) {
  const query = new URLSearchParams({ workspaceId })
  return cancelPreviewSchema.parse(
    await requestJson(`/api/ai/tasks/${encodeURIComponent(taskId)}/cancel?${query}`),
  )
}

export async function cancelMediaTask(workspaceId: string, taskId: string) {
  return z
    .object({
      taskId: z.uuid(),
      status: taskSchema.shape.status,
      cancellationPending: z.boolean(),
      cancelBilling: taskSchema.shape.cancelBilling,
      creditsCharged: z.number().int().nonnegative(),
    })
    .parse(
      await requestJson(`/api/ai/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      }),
    )
}
