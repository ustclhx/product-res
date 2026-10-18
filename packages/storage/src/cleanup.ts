import { WORKSPACE_RETENTION_DAYS } from '@product-res/auth'
import { type Database, file, organization, scoped } from '@product-res/db'
import { log } from '@product-res/shared/log'
import { and, eq, isNotNull, lt, type SQL, sql } from 'drizzle-orm'
import type { Storage } from './storage.ts'

const PENDING_RETENTION_MS = 60 * 60 * 1000

/** 清理未确认上传与超过空间保留期的文件；对象删除失败时保留记录供 Cron 重试。 */
export async function cleanupFiles(
  db: Database,
  bucket: Pick<Storage, 'delete'>,
  { now = new Date() }: { readonly now?: Date } = {},
) {
  const pendingBefore = new Date(now.getTime() - PENDING_RETENTION_MS)
  const workspaceBefore = new Date(now.getTime() - WORKSPACE_RETENTION_DAYS * 86_400_000)
  // 系统任务只跨空间发现候选；文件读取与删除在下方通过 scoped 执行。
  const workspaces = await db.$client<{ workspace_id: string }[]>`
    select distinct f.workspace_id from file f join organization o on o.id=f.workspace_id
    where (f.status='pending' and f.created_at<${pendingBefore.toISOString()})
      or o.deleted_at<=${workspaceBefore.toISOString()}
      or (f.purpose='ai_output' and f.status='ready' and f.deleted_at is not null)
    order by f.workspace_id`
  let deleted = 0
  let failed = 0
  for (const { workspace_id: workspaceId } of workspaces) {
    const tenant = scoped(db, workspaceId)
    // 失败/取消的 ready 产出不会再复活；先删对象再删墓碑，中断后可安全重试。
    const abandoned = await tenant.select(file, {
      where: and(
        eq(file.purpose, 'ai_output'),
        eq(file.status, 'ready'),
        isNotNull(file.deletedAt),
      ) as SQL,
    })
    for (const candidate of abandoned) {
      try {
        await bucket.delete(candidate.r2Key)
        const removed = await tenant
          .delete(file, and(eq(file.id, candidate.id), isNotNull(file.deletedAt)))
          .returning({ id: file.id })
        deleted += removed.length
      } catch {
        failed++
        log.warn('storage.cleanup.object_failed', { workspaceId, fileId: candidate.id })
      }
    }
    const result = await db.transaction(async (tx) => {
      // 与上传确认及 restoreWorkspace 共用锁，避免候选读取后文件被确认或空间被恢复。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`,
      )
      const [workspace] = await tx
        .select({ deletedAt: organization.deletedAt })
        .from(organization)
        .where(eq(organization.id, workspaceId))
        .for('update')
      if (!workspace) return { deleted: 0, failed: 0 }
      const expired =
        workspace.deletedAt !== null && workspace.deletedAt.getTime() <= workspaceBefore.getTime()
      const tenant = scoped(tx, workspaceId)
      const files = await tenant
        .select(file, {
          fields: { id: file.id, r2Key: file.r2Key },
          ...(expired
            ? {}
            : { where: and(eq(file.status, 'pending'), lt(file.createdAt, pendingBefore)) as SQL }),
        })
        .for('update')
      let deleted = 0
      let failed = 0
      for (const candidate of files) {
        try {
          await bucket.delete(candidate.r2Key)
        } catch {
          failed++
          log.warn('storage.cleanup.object_failed', { workspaceId, fileId: candidate.id })
          continue
        }
        // R2 删除幂等；数据库提交失败时仍保留记录，下次可以安全重试。
        await tenant.delete(file, eq(file.id, candidate.id))
        deleted++
      }
      return { deleted, failed }
    })
    deleted += result.deleted
    failed += result.failed
  }
  return { deleted, failed }
}
