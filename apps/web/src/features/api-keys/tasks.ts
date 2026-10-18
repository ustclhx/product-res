import type { MediaTaskFile } from '@product-res/ai'
import { type Capability, type RateLimiter, requireCapability } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { currentRequestId } from '@product-res/shared/log'
import { z } from 'zod'
import {
  getWorkspaceMediaTask,
  type MediaHttpDeps,
  submitWorkspaceMedia,
} from '../ai/media-tasks.ts'
import { apiError } from './completions.ts'
import { type ApiKeyDeps, authenticateApiKey } from './service.ts'

export type PublicMediaDeps = Omit<ApiKeyDeps, 'entitlements'> &
  Omit<MediaHttpDeps, 'auth' | 'rateLimiter' | 'env'> & {
    env: MediaHttpDeps['env']
    rateLimiter: RateLimiter
    downloadFile: Capability<(input: { workspaceId: string; fileId: string }) => Promise<string>>
  }

const inputSchema = z
  .object({
    model: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()

function result(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'x-request-id': currentRequestId() ?? '' },
  })
}

export async function handlePublicMediaSubmit(request: Request, deps: PublicMediaDeps) {
  try {
    const context = await authenticateApiKey(request, deps)
    const parsed = inputSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid media task request')
    const task = await submitWorkspaceMedia(
      { modelKey: parsed.data.model, params: parsed.data.params },
      context,
      {
        ...deps,
        faultAccess: { enabled: false, platformAdmin: false },
        // 公开入口已经按 Key 和空间限流；事务内仍实时读取模型权益与配额。
        rateLimiter: undefined,
        callbackOrigin: new URL(deps.env.APP_URL ?? request.url).origin,
      },
    )
    return result(
      { id: task.id, object: 'media.task', model: task.modelKey, status: task.status },
      202,
    )
  } catch (error) {
    return apiError(error)
  }
}

export async function handlePublicMediaDetail(
  request: Request,
  taskId: string,
  deps: PublicMediaDeps,
) {
  try {
    const context = await authenticateApiKey(request, deps)
    if (!z.uuid().safeParse(taskId).success)
      throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    const task = await getWorkspaceMediaTask(context, taskId, deps)
    const output = task.output as { files?: MediaTaskFile[] } | null
    const signedFiles = await Promise.all(
      (task.status === 'succeeded' ? (output?.files ?? []) : []).map(async (file) => {
        // 产出文件被用户删除后只从列表中省略，任务本身仍可查询。
        const downloadUrl = await requireCapability(
          deps.downloadFile,
          'files',
        )({
          workspaceId: context.workspace.id,
          fileId: file.id,
        }).catch((error: unknown) => {
          if (error instanceof AppError && error.status === 404) return null
          throw error
        })
        if (!downloadUrl) return null
        // 过期时间取签名本身，避免异步签名与响应时钟之间的偏差。
        const signed = new URL(downloadUrl)
        const date = signed.searchParams.get('X-Amz-Date') as string
        const signedAt = Date.parse(
          date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
        )
        return {
          id: file.id,
          mime: file.mime,
          size: file.size,
          width: file.width ?? null,
          height: file.height ?? null,
          duration: file.duration ?? null,
          download_url: downloadUrl,
          expires_at:
            Math.floor(signedAt / 1000) + Number(signed.searchParams.get('X-Amz-Expires')),
        }
      }),
    )
    const files = signedFiles.filter((file) => file !== null)
    return result({
      id: task.id,
      object: 'media.task',
      model: task.modelKey,
      kind: task.kind,
      status: task.status,
      created: Math.floor(task.createdAt.getTime() / 1000),
      finished_at: task.finishedAt ? Math.floor(task.finishedAt.getTime() / 1000) : null,
      credits_charged: task.creditsCharged,
      error: task.errorCode ? { code: task.errorCode, message: task.errorMessage } : null,
      files,
    })
  } catch (error) {
    return apiError(error)
  }
}
