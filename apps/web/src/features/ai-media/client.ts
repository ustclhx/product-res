import { z } from 'zod'

const taskResponse = z.object({ taskId: z.uuid() })

/** 5.1 只依赖任务接口契约；服务端任务创建由 4.1 提供。 */
export async function submitMediaTask(input: {
  workspaceId: string
  modelKey: string
  params: Record<string, unknown>
}) {
  const body = await postJson('/api/ai/tasks', input, 'MEDIA_SUBMIT_FAILED')
  const result = taskResponse.safeParse(body)
  if (!result.success) throw new Error('MEDIA_SUBMIT_FAILED')
  return result.data
}

async function postJson(path: string, input: unknown, failureCode: string) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(body)
    throw new Error(error.success ? error.data.error.code : failureCode)
  }
  return body
}

export interface MediaFile {
  id: string
  mime: string
  size: number
  status: 'pending' | 'ready'
}

export interface UploadActions {
  declare: (input: { workspaceId: string; mime: string; size: number }) => Promise<{
    fileId: string
    uploadUrl: string
    headers: Record<string, string>
  }>
  complete: (input: { workspaceId: string; fileId: string }) => Promise<MediaFile>
  put?: typeof fetch
}

const declarationResponse = z.object({
  fileId: z.uuid(),
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
})
const readyResponse = z.object({
  id: z.uuid(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  status: z.literal('ready'),
})

// 现有 HTTP 文件接口与 files.functions.ts 复用同一存储流程，且不会向客户端引入 server-only 中间件。
export const fileUploadActions: UploadActions = {
  async declare(input) {
    const result = declarationResponse.safeParse(
      await postJson('/api/files/uploads', input, 'MEDIA_UPLOAD_FAILED'),
    )
    if (!result.success) throw new Error('MEDIA_UPLOAD_FAILED')
    return result.data
  },
  async complete({ workspaceId, fileId }) {
    const result = readyResponse.safeParse(
      await postJson(
        `/api/files/${encodeURIComponent(fileId)}/complete`,
        { workspaceId },
        'MEDIA_UPLOAD_FAILED',
      ),
    )
    if (!result.success) throw new Error('MEDIA_UPLOAD_FAILED')
    return result.data
  },
}

/** 确认通过之前不返回 fileId 给参数表单，失败的 pending 文件交给已有清理流程。 */
export async function uploadMediaFile(
  workspaceId: string,
  file: File,
  actions: UploadActions,
): Promise<MediaFile> {
  const declared = await actions.declare({ workspaceId, mime: file.type, size: file.size })
  const response = await (actions.put ?? fetch)(declared.uploadUrl, {
    method: 'PUT',
    headers: declared.headers,
    body: file,
  })
  if (!response.ok) throw new Error('MEDIA_UPLOAD_FAILED')
  const ready = await actions.complete({ workspaceId, fileId: declared.fileId })
  if (ready.status !== 'ready' || ready.id !== declared.fileId)
    throw new Error('MEDIA_UPLOAD_FAILED')
  return ready
}
