import {
  type AiTask,
  aiTask,
  type Database,
  type File,
  file,
  notFound,
  organization,
  scoped,
} from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getStorageUsage } from './files.ts'
import { allowedUrl } from './media-validation.ts'
import type { Storage } from './storage.ts'

/** 结构兼容 MediaResult；storage 不依赖 AI Provider。 */
export interface MediaCopyResult {
  readonly outputs: readonly {
    readonly url: string
    readonly mime: string
    readonly width?: number
    readonly height?: number
    readonly durationSec?: number
  }[]
}

/** 同步 Provider 的字节只在当前 step 内使用，不写入任务 JSON。 */
export interface MediaBinaryCopyResult {
  readonly outputs: readonly {
    readonly body: Uint8Array | ReadableStream<Uint8Array>
    readonly mime: string
    readonly width?: number
    readonly height?: number
    readonly durationSec?: number
  }[]
}
export type MediaCopyOutput = (MediaCopyResult | MediaBinaryCopyResult)['outputs'][number]

export interface MediaCopyLimits {
  readonly maxFileBytes: number
  readonly storageBytes: number
  readonly allowedMimeTypes: readonly string[]
  /** 精确域名；允许其子域时显式写成 *.example.com。 */
  readonly allowedHosts: readonly string[]
}

export type PersistedMediaFile = Pick<
  File,
  'id' | 'mime' | 'size' | 'width' | 'height' | 'duration'
>
/** Adapter 验证下载响应类型与实际字节限额，并返回成功存储的元数据。 */
export type MediaOutputCopier = (
  key: string,
  output: MediaCopyOutput,
  limits: MediaCopyLimits,
) => Promise<{ mime: string; size: number }>

function describeFile(row: File): PersistedMediaFile {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
  }
}

/** 确定性对象 key 与唯一 file.r2Key 让 Workflow 步骤可安全重放。 */
async function persistMediaOutputsImpl({
  db,
  storage,
  copyOutput,
  task,
  result,
  limits,
}: {
  readonly db: Database
  readonly storage: Pick<Storage, 'delete'>
  readonly copyOutput: MediaOutputCopier
  readonly task: Pick<AiTask, 'id' | 'workspaceId' | 'userId'>
  readonly result: MediaCopyResult | MediaBinaryCopyResult
  readonly limits: MediaCopyLimits
}): Promise<PersistedMediaFile[]> {
  // Workflow 同一实例的转存步骤串行重放；pending 记录作为中断后的清理线索。
  for (const output of result.outputs) {
    if ('url' in output) allowedUrl(output.url, limits.allowedHosts)
    if (!limits.allowedMimeTypes.includes(output.mime))
      throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Media type is not allowed')
  }
  const plan = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, task.workspaceId)
    const [current] = await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
    if (!current) throw notFound()
    if (current.status === 'failed' || current.status === 'canceled')
      throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer active', { status: 409 })
    const [workspace] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, task.workspaceId), isNull(organization.deletedAt)))
    if (!workspace) throw notFound()
    const entries: { row: File; output: MediaCopyOutput }[] = []
    for (const [index, output] of result.outputs.entries()) {
      const key = `ws/${task.workspaceId}/ai/${task.id}/${index}`
      const [existing] = await tenant.select(file, { where: eq(file.r2Key, key) })
      if (existing?.status === 'ready' && !existing.deletedAt) {
        entries.push({ row: existing, output })
        continue
      }
      if (current.status === 'succeeded' || existing?.status === 'ready')
        throw new AppError('MEDIA_TASK_TERMINAL', 'Media output is no longer writable', {
          status: 409,
        })
      const values = {
        userId: current.userId,
        purpose: 'ai_output' as const,
        status: 'pending' as const,
        r2Key: key,
        mime: output.mime,
        size: 0,
        sourceTaskId: task.id,
        width: output.width,
        height: output.height,
        duration: output.durationSec,
        deletedAt: null,
        // pending 重试重新开始清理窗口，避免上一轮旧记录在本轮复制中被 Cron 清理。
        createdAt: new Date(),
      }
      const [row] = await tenant
        .insert(file, values)
        .onConflictDoUpdate({ target: file.r2Key, set: values })
        .returning()
      if (!row) throw new Error('Media file insert returned no row')
      entries.push({ row, output })
    }
    return entries
  })

  try {
    const copied = new Map<string, { mime: string; size: number }>()
    // 下载与上传不持有数据库连接或空间锁。
    for (const entry of plan) {
      if (entry.row.status === 'ready') continue
      copied.set(entry.row.id, await copyOutput(entry.row.r2Key, entry.output, limits))
    }
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
      )
      const tenant = scoped(tx, task.workspaceId)
      const [current] = await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
      if (!current) throw notFound()
      if (current.status === 'failed' || current.status === 'canceled')
        throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer active', {
          status: 409,
        })
      const [workspace] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(and(eq(organization.id, task.workspaceId), isNull(organization.deletedAt)))
      if (!workspace) throw notFound()
      const rows = await Promise.all(plan.map((entry) => tenant.findById(file, entry.row.id)))
      let addedBytes = 0
      for (const row of rows) {
        if (row.deletedAt)
          throw new AppError('MEDIA_TASK_TERMINAL', 'Media output is no longer writable', {
            status: 409,
          })
        if (row.status === 'ready') continue
        if (current.status === 'succeeded')
          throw new AppError('MEDIA_TASK_TERMINAL', 'Media task is no longer writable', {
            status: 409,
          })
        const stored = copied.get(row.id)
        if (!stored) throw new Error('Missing copied media output')
        addedBytes += stored.size
      }
      if (
        addedBytes &&
        (await getStorageUsage(tx, task.workspaceId)) + addedBytes > limits.storageBytes
      )
        throw new AppError('UPGRADE_REQUIRED', 'Workspace storage quota exceeded', {
          status: 403,
        })
      const files: PersistedMediaFile[] = []
      for (const row of rows) {
        const stored = copied.get(row.id)
        files.push(
          describeFile(
            row.status === 'ready'
              ? row
              : await tenant.updateById(file, row.id, {
                  status: 'ready',
                  size: stored?.size,
                  mime: stored?.mime,
                }),
          ),
        )
      }
      return files
    })
  } catch (error) {
    try {
      const abandoned = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
        )
        const tenant = scoped(tx, task.workspaceId)
        const keys: string[] = []
        for (const entry of plan) {
          if (entry.row.status === 'ready') continue
          const [row] = await tenant
            .select(file, { where: eq(file.id, entry.row.id) })
            .for('update')
          // COMMIT 响应丢失或已完成重放时，绝不能删除已确认对象。
          if (!row || row.status === 'ready') continue
          await tenant.updateById(file, row.id, { deletedAt: new Date() })
          keys.push(row.r2Key)
        }
        return keys
      })
      for (const key of abandoned) {
        try {
          await storage.delete(key)
        } catch {
          log.warn('storage.media.cleanup_failed', {
            workspaceId: task.workspaceId,
            taskId: task.id,
            key,
          })
        }
      }
    } catch {
      log.warn('storage.media.cleanup_transaction_failed', {
        workspaceId: task.workspaceId,
        taskId: task.id,
      })
    }
    throw error
  }
}

export async function persistMediaOutputs(
  input: Parameters<typeof persistMediaOutputsImpl>[0],
): Promise<PersistedMediaFile[]> {
  try {
    return await persistMediaOutputsImpl(input)
  } finally {
    // 已确认文件复用或校验失败时，同步产出流也必须释放上游 reader。
    const unused = input.result.outputs.flatMap((output) =>
      'body' in output && output.body instanceof ReadableStream && !output.body.locked
        ? [output.body.cancel()]
        : [],
    )
    const cleanup = await Promise.allSettled(unused)
    if (cleanup.some((entry) => entry.status === 'rejected'))
      log.warn('storage.media.stream_cancel_failed', { taskId: input.task.id })
  }
}
