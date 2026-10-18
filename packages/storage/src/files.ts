import { type Database, type File, file, notFound, organization, scoped } from '@product-res/db'
import {
  type EntitlementOptions,
  getEntitlements,
  requireEntitlement,
} from '@product-res/entitlements'
import { AppError, newId } from '@product-res/shared'
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm'
import type { Storage } from './storage.ts'

type StorageDatabase = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
] as const
const GB = 1024 ** 3

async function activeWorkspace(db: StorageDatabase, workspaceId: string) {
  const [workspace] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(and(eq(organization.id, workspaceId), isNull(organization.deletedAt)))
    .limit(1)
  if (!workspace) throw notFound()
}

export async function getStorageUsage(db: StorageDatabase, workspaceId: string): Promise<number> {
  const [row] = await scoped(db, workspaceId).select(file, {
    fields: { bytes: sql<string>`coalesce(sum(${file.size}), 0)` },
    where: and(eq(file.status, 'ready'), isNull(file.deletedAt)) as SQL,
  })
  return Number(row?.bytes ?? 0)
}

async function checkQuota(
  db: StorageDatabase,
  workspaceId: string,
  bytes: number,
  options: EntitlementOptions,
) {
  const entitlements = await getEntitlements(db, workspaceId, options)
  requireEntitlement(entitlements, {
    limit: 'storageGb',
    value: ((await getStorageUsage(db, workspaceId)) + bytes) / GB,
  })
}

function checkDeclaration(mime: string, size: number) {
  if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(mime))
    throw new AppError('FILE_TYPE_NOT_ALLOWED', 'File type is not allowed')
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES)
    throw new AppError('FILE_TOO_LARGE', 'File must be between 1 byte and 100 MiB')
}

export async function declareUpload(
  db: Database,
  storage: Storage,
  input: { workspaceId: string; userId: string; mime: string; size: number },
  options: EntitlementOptions = {},
) {
  checkDeclaration(input.mime, input.size)
  const fileId = newId()
  const r2Key = `ws/${input.workspaceId}/${fileId}`
  const signature = await storage.presignUpload(r2Key, input.mime)
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${input.workspaceId}`}, 0))`,
    )
    await activeWorkspace(tx, input.workspaceId)
    await checkQuota(tx, input.workspaceId, input.size, options)
    await scoped(tx, input.workspaceId).insert(file, {
      id: fileId,
      userId: input.userId,
      purpose: 'upload',
      status: 'pending',
      r2Key,
      mime: input.mime,
      size: input.size,
    })
  })
  return { fileId, ...signature }
}

async function visibleFile(
  db: StorageDatabase,
  workspaceId: string,
  fileId: string,
  ready = false,
) {
  await activeWorkspace(db, workspaceId)
  const row = await scoped(db, workspaceId).findById(file, fileId)
  if (row.deletedAt || (ready && row.status !== 'ready')) throw notFound()
  return row
}

export async function completeUpload(
  db: Database,
  storage: Storage,
  input: { workspaceId: string; fileId: string },
  options: EntitlementOptions = {},
): Promise<File> {
  const initial = await visibleFile(db, input.workspaceId, input.fileId)
  if (initial.status === 'ready') return initial
  const object = await storage.head(initial.r2Key)
  if (!object) throw new AppError('UPLOAD_NOT_FOUND', 'Upload has not completed', { status: 409 })
  const result = await db.transaction(async (tx) => {
    // 确认与清理、删空间和其他确认共用空间锁；仅 ready 文件计入已用配额。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${input.workspaceId}`}, 0))`,
    )
    const row = await visibleFile(tx, input.workspaceId, input.fileId)
    if (row.status === 'ready') return { row }
    let error: AppError | undefined
    if (object.size !== row.size || object.mime !== row.mime || object.size > MAX_UPLOAD_BYTES) {
      error = new AppError('UPLOAD_MISMATCH', 'Uploaded size or type differs from declaration')
    } else {
      try {
        await checkQuota(tx, input.workspaceId, object.size, options)
      } catch (cause) {
        if (!(cause instanceof AppError)) throw cause
        error = cause
      }
    }
    if (error) {
      // 保留 pending 墓碑到签名过期后清理，R2 删除失败也仍有重试线索。
      await scoped(tx, input.workspaceId).updateById(file, row.id, { deletedAt: new Date() })
      return { row, error }
    }
    return {
      row: await scoped(tx, input.workspaceId).updateById(file, row.id, {
        status: 'ready',
        size: object.size,
      }),
    }
  })
  if (result.error) {
    await storage.delete(result.row.r2Key)
    throw result.error
  }
  return result.row
}

export async function getFileDownload(
  db: Database,
  storage: Storage,
  input: { workspaceId: string; fileId: string; download?: boolean },
) {
  const row = await visibleFile(db, input.workspaceId, input.fileId, true)
  return storage.presignDownload(row.r2Key, input.download)
}

async function ownedFile(
  db: StorageDatabase,
  input: { workspaceId: string; userId: string; fileId: string },
) {
  const row = await visibleFile(db, input.workspaceId, input.fileId, true)
  if (row.userId !== input.userId) throw notFound()
  return row
}

export async function createFileShare(
  db: Database,
  input: { workspaceId: string; userId: string; fileId: string },
) {
  const row = await ownedFile(db, input)
  const updated = await scoped(db, input.workspaceId).updateById(file, row.id, {
    // 原子读取当前 token；并发撤销已清空时生成新值，不能把先前读出的旧链接复活。
    publicToken: sql`coalesce(${file.publicToken}, ${crypto.randomUUID()})`,
  })
  return updated.publicToken as string
}

export async function revokeFileShare(
  db: Database,
  input: { workspaceId: string; userId: string; fileId: string },
) {
  const row = await ownedFile(db, input)
  await scoped(db, input.workspaceId).updateById(file, row.id, { publicToken: null })
}

export async function getSharedFileDownload(db: Database, storage: Storage, token: string) {
  // 公开 token 是跨租户定位入口，找到空间后仍通过 scoped 校验文件状态与软删状态。
  const [entry] = await db
    .select({ id: file.id, workspaceId: file.workspaceId })
    .from(file)
    .where(eq(file.publicToken, token))
    .limit(1)
  if (!entry) throw notFound()
  const row = await visibleFile(db, entry.workspaceId, entry.id, true)
  if (row.publicToken !== token) throw notFound()
  return storage.presignDownload(row.r2Key)
}
