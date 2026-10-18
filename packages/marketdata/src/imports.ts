import type { ColumnMapping, ImportContext, ImportPreview } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { dataImport, importTemplate, observation, rawPayload } from '@product-res/db/schema'
import { AppError } from '@product-res/shared'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { type RawArchive, sha256Hex } from './archive.ts'
import { upsertEntities, upsertObservations } from './observations.ts'

export interface CommitImportInput {
  readonly fileName: string
  readonly file: Uint8Array
  readonly contentType: string
  readonly context: ImportContext
  readonly preview: ImportPreview
  /** 存在错误行时必须显式选择跳过 */
  readonly skipErrorRows: boolean
  /** 同一文件（哈希相同）重复导入时必须显式确认 */
  readonly confirmDuplicate: boolean
  readonly templateId?: string
  readonly userId?: string
  readonly now: Date
}

/** 同一文件是否已导入且未撤销 */
export async function findDuplicateImport(db: Database, file: Uint8Array) {
  const sha256 = await sha256Hex(file)
  const [row] = await db
    .select()
    .from(dataImport)
    .where(and(eq(dataImport.sha256, sha256), isNull(dataImport.revertedAt)))
    .limit(1)
  return row
}

/**
 * 确认导入（specs/data-import「导入来源标注」）：原文件存档，观测值的获取方式为手工导入并引用导入批次。
 */
export async function commitImport(db: Database, archive: RawArchive, input: CommitImportInput) {
  const { preview, context } = input
  if (preview.issues.some((i) => i.row === 0))
    throw new AppError('IMPORT_INVALID', preview.issues.map((i) => i.message).join('；'), {
      status: 400,
    })
  if (preview.errorRows.length > 0 && !input.skipErrorRows)
    throw new AppError(
      'IMPORT_HAS_ERRORS',
      `有 ${preview.errorRows.length} 行错误，请修改或选择跳过`,
      {
        status: 400,
      },
    )
  if (!input.confirmDuplicate && (await findDuplicateImport(db, input.file)))
    throw new AppError('IMPORT_DUPLICATE', '该文件已经导入过，请确认是否重复导入', { status: 409 })
  const sha256 = await sha256Hex(input.file)
  const [batch] = await db
    .insert(dataImport)
    .values({
      sourceId: context.sourceId,
      templateId: input.templateId ?? null,
      fileName: input.fileName,
      sha256,
      context: { ...context },
      rowCount: preview.rowCount,
      importedCount: 0,
      skippedRows: preview.errorRows.length,
      createdBy: input.userId ?? null,
    })
    .returning({ id: dataImport.id })
  const importId = (batch as { id: string }).id
  const archived = await archive.put({
    sourceId: context.sourceId,
    importId,
    task: { kind: 'import', fileName: input.fileName },
    request: { method: 'UPLOAD', url: `file:${input.fileName}` },
    status: 200,
    body: input.file,
    contentType: input.contentType,
    fetchedAt: input.now,
  })
  const ids = await upsertEntities(db, preview.entities)
  const imported = await upsertObservations(db, preview.observations, ids, {
    sourceId: context.sourceId,
    fetchedAt: input.now,
    rawPayloadId: archived.id,
    importId,
  })
  await db
    .update(dataImport)
    .set({ importedCount: imported, rawPayloadId: archived.id })
    .where(eq(dataImport.id, importId))
  return { importId, imported, skippedRows: preview.errorRows.length }
}

/** 撤销导入批次：只删除该批次写入的观测值，批次记录与原文件保留 */
export async function revertImport(db: Database, importId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(dataImport)
      .where(eq(dataImport.id, importId))
      .for('update')
    if (!row) throw new AppError('NOT_FOUND', 'Import not found', { status: 404 })
    if (row.revertedAt) return 0
    const removed = await tx
      .delete(observation)
      .where(eq(observation.importId, importId))
      .returning({
        metric: observation.metric,
      })
    await tx.update(dataImport).set({ revertedAt: now }).where(eq(dataImport.id, importId))
    return removed.length
  })
}

export async function listImports(db: Database, limit = 50) {
  return db.select().from(dataImport).orderBy(desc(dataImport.createdAt)).limit(limit)
}

export async function saveTemplate(
  db: Database,
  input: {
    sourceId: string
    name: string
    mapping: ColumnMapping
    defaults?: Record<string, unknown>
  },
) {
  const [row] = await db
    .insert(importTemplate)
    .values({
      sourceId: input.sourceId,
      name: input.name,
      mapping: input.mapping as Record<string, unknown>,
      defaults: input.defaults ?? {},
    })
    .onConflictDoUpdate({
      target: [importTemplate.sourceId, importTemplate.name],
      set: {
        mapping: sql`excluded.mapping`,
        defaults: sql`excluded.defaults`,
        updatedAt: sql`now()`,
      },
    })
    .returning()
  return row
}

export async function listTemplates(db: Database, sourceId?: string) {
  return db
    .select()
    .from(importTemplate)
    .where(sourceId ? eq(importTemplate.sourceId, sourceId) : undefined)
    .orderBy(importTemplate.name)
}

/** 导入批次引用的原文件（数据中心下载 / 追溯用） */
export async function importFile(db: Database, archive: RawArchive, importId: string) {
  const [row] = await db
    .select({ rawPayloadId: dataImport.rawPayloadId, fileName: dataImport.fileName })
    .from(dataImport)
    .where(eq(dataImport.id, importId))
  if (!row?.rawPayloadId) return null
  const [meta] = await db
    .select({ id: rawPayload.id })
    .from(rawPayload)
    .where(eq(rawPayload.id, row.rawPayloadId))
  if (!meta) return null
  const stored = await archive.get(meta.id)
  return stored ? { ...stored, fileName: row.fileName } : null
}
