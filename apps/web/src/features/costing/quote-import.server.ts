import { detectImportKind, parseImportFile } from '@product-res/datasources'
import {
  cluster,
  clusterMember,
  dataImport,
  marketplaceProduct,
  type Scoped,
  scoped,
  supplier,
  supplierQuote,
} from '@product-res/db'
import { createDbArchive, sha256Hex } from '@product-res/marketdata'
import { AppError } from '@product-res/shared'
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { assertWorkbenchWriter } from '../workbench/access.ts'
import { todaySgt } from './dates.ts'
import type { DecisionActor } from './decisions.server.ts'
import { isLeadDecided } from './labels.ts'
import { parseQuoteTable, type QuoteDraft, type QuoteIssue } from './quote-import.ts'
import { QUOTE_IMPORT_SOURCE } from './quote-template.ts'
import { enterCosting, latestLeadOf, removeQuotes } from './quotes.server.ts'

/**
 * 数据中心“供应商报价”导入（specs/supplier-quotes「报价导入」）：复用数据中心的文件解析、原文件存档与
 * data_import 批次记录；报价写入空间级 supplier_quote（来源 import、记录 import_id），
 * 撤销只删除该批次导入且仍为导入来源的报价，手工录入（或导入后手工改过）的报价保留。
 * data_import 是部署级表，批次的空间记在 context.workspaceId，其他空间看不到也不能撤销。
 */

const MAX_BYTES = 5 * 1024 * 1024
const all = (...conditions: (SQL | undefined)[]) => and(...conditions) as SQL

export interface QuoteImportRequest {
  fileName: string
  contentBase64: string
  sheetName?: string | undefined
  /** 平台商品 ID 所在站点 */
  marketplace: string
  /** 币种列为空时使用 */
  currency: string
}

function decode(input: QuoteImportRequest) {
  const bytes = Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0))
  if (bytes.byteLength > MAX_BYTES)
    throw new AppError('IMPORT_TOO_LARGE', '文件超过 5 MB', { status: 413 })
  if (!detectImportKind(input.fileName))
    throw new AppError(
      'IMPORT_UNSUPPORTED',
      '支持 CSV / TSV / XLSX 文件（旧版 .xls 请另存为 .xlsx）',
      {
        status: 400,
      },
    )
  return bytes
}

type Resolved = QuoteDraft & { clusterId: string; clusterName: string }

/** 把草稿关联到本空间的有效商品簇；簇的最新线索已决定时该行报错（核算已锁定） */
async function resolveClusters(
  s: Scoped,
  db: DecisionActor['db'],
  drafts: QuoteDraft[],
  marketplace: string,
) {
  const issues: QuoteIssue[] = []
  const byId = new Map<string, { id: string; name: string }>()
  const ids = [...new Set(drafts.flatMap((d) => (d.clusterId ? [d.clusterId] : [])))]
  if (ids.length)
    for (const c of await s.select(cluster, {
      where: all(inArray(cluster.id, ids), eq(cluster.status, 'active')),
      fields: { id: cluster.id, name: cluster.name },
    }))
      byId.set(c.id, c)

  // 平台商品 ID → 包含该商品的有效簇（部署级商品表 → 本空间成员表）
  const platformIds = [
    ...new Set(drafts.flatMap((d) => (!d.clusterId && d.platformId ? [d.platformId] : []))),
  ]
  const byPlatform = new Map<string, { id: string; name: string }[]>()
  if (platformIds.length) {
    const products = await db
      .select({ id: marketplaceProduct.id, platformId: marketplaceProduct.platformId })
      .from(marketplaceProduct)
      .where(
        and(
          eq(marketplaceProduct.marketplace, marketplace),
          inArray(marketplaceProduct.platformId, platformIds),
        ),
      )
    const members = products.length
      ? await s.select(clusterMember, {
          where: inArray(
            clusterMember.productId,
            products.map((p) => p.id),
          ),
          fields: { clusterId: clusterMember.clusterId, productId: clusterMember.productId },
        })
      : []
    const clusters = members.length
      ? await s.select(cluster, {
          where: all(
            inArray(cluster.id, [...new Set(members.map((m) => m.clusterId))]),
            eq(cluster.status, 'active'),
          ),
          fields: { id: cluster.id, name: cluster.name },
        })
      : []
    const clusterById = new Map(clusters.map((c) => [c.id, c]))
    for (const p of products) {
      const list = members
        .filter((m) => m.productId === p.id)
        .flatMap((m) => {
          const c = clusterById.get(m.clusterId)
          return c ? [c] : []
        })
      byPlatform.set(p.platformId, list)
    }
  }

  const resolved: Resolved[] = []
  const locked = new Map<string, boolean>()
  for (const d of drafts) {
    let target: { id: string; name: string } | undefined
    if (d.clusterId) {
      target = byId.get(d.clusterId)
      if (!target) {
        issues.push({ row: d.row, column: '簇 ID', message: '本空间没有这个有效商品簇' })
        continue
      }
    } else {
      const list = byPlatform.get(d.platformId as string) ?? []
      if (list.length === 0) {
        issues.push({
          row: d.row,
          column: '平台商品 ID',
          message: `在 ${marketplace} 没有包含该商品的商品簇`,
        })
        continue
      }
      if (list.length > 1) {
        issues.push({
          row: d.row,
          column: '平台商品 ID',
          message: '该商品属于多个商品簇，请改填簇 ID',
        })
        continue
      }
      target = list[0]
    }
    const t = target as { id: string; name: string }
    if (!locked.has(t.id)) {
      const latest = await latestLeadOf(s, t.id)
      locked.set(t.id, Boolean(latest && isLeadDecided(latest.status)))
    }
    if (locked.get(t.id)) {
      issues.push({ row: d.row, message: '该商品簇的线索已作出决定，核算已锁定' })
      continue
    }
    resolved.push({ ...d, clusterId: t.id, clusterName: t.name })
  }
  return { resolved, issues }
}

async function parse(actor: DecisionActor, input: QuoteImportRequest) {
  const bytes = decode(input)
  let file: Awaited<ReturnType<typeof parseImportFile>>
  try {
    file = await parseImportFile(input.fileName, bytes, input.sheetName)
  } catch (error) {
    throw new AppError(
      'IMPORT_INVALID_FILE',
      error instanceof Error ? error.message : '文件无法解析',
      {
        status: 400,
      },
    )
  }
  const table = parseQuoteTable(file.table, {
    currency: input.currency.toUpperCase(),
    quotedOn: todaySgt(new Date()),
  })
  const s = scoped(actor.db, actor.workspaceId)
  const { resolved, issues } = await resolveClusters(s, actor.db, table.drafts, input.marketplace)
  const allIssues = [...table.issues, ...issues].sort((a, b) => a.row - b.row)
  const errorRows = [...new Set(allIssues.filter((i) => i.row > 0).map((i) => i.row))].sort(
    (a, b) => a - b,
  )
  return { bytes, file, table, resolved, issues: allIssues, errorRows }
}

export async function previewQuoteImport(actor: DecisionActor, input: QuoteImportRequest) {
  assertWorkbenchWriter(actor)
  const p = await parse(actor, input)
  return {
    sheetNames: p.file.sheetNames,
    sheetName: p.file.sheetName,
    headers: p.table.headers,
    unknownHeaders: p.table.unknown,
    rowCount: Math.max(0, p.file.table.length - 1),
    quoteCount: p.resolved.length,
    clusterCount: new Set(p.resolved.map((r) => r.clusterId)).size,
    rows: p.resolved.slice(0, 50).map((r) => ({
      row: r.row,
      clusterName: r.clusterName,
      supplier: r.supplier.name,
      tiers: r.tiers,
      currency: r.currency,
      moq: r.moq,
      weightG: r.weightG,
      dimensions: r.dimensions,
      confidence: r.confidence,
      quotedOn: r.quotedOn,
    })),
    issues: p.issues.slice(0, 200),
    errorRows: p.errorRows,
  }
}

export async function commitQuoteImport(
  actor: DecisionActor,
  input: QuoteImportRequest & { skipErrorRows: boolean; confirmDuplicate: boolean },
  now = new Date(),
) {
  assertWorkbenchWriter(actor)
  const p = await parse(actor, input)
  if (p.issues.some((i) => i.row === 0))
    throw new AppError('IMPORT_INVALID', p.issues.map((i) => i.message).join('；'), { status: 400 })
  if (p.errorRows.length > 0 && !input.skipErrorRows)
    throw new AppError('IMPORT_HAS_ERRORS', `有 ${p.errorRows.length} 行错误，请修改或选择跳过`, {
      status: 400,
    })
  if (p.resolved.length === 0)
    throw new AppError('IMPORT_EMPTY', '没有可导入的报价', { status: 400 })
  const sha256 = await sha256Hex(p.bytes)
  if (!input.confirmDuplicate) {
    const [dup] = await actor.db
      .select({ id: dataImport.id })
      .from(dataImport)
      .where(
        all(
          eq(dataImport.sha256, sha256),
          eq(dataImport.sourceId, QUOTE_IMPORT_SOURCE),
          isNull(dataImport.revertedAt),
          sql`${dataImport.context}->>'workspaceId' = ${actor.workspaceId}`,
        ),
      )
      .limit(1)
    if (dup)
      throw new AppError('IMPORT_DUPLICATE', '该文件已经导入过，请确认是否重复导入', {
        status: 409,
      })
  }

  return actor.db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(dataImport)
      .values({
        sourceId: QUOTE_IMPORT_SOURCE,
        fileName: input.fileName,
        sha256,
        context: {
          sourceId: QUOTE_IMPORT_SOURCE,
          workspaceId: actor.workspaceId,
          marketplace: input.marketplace,
          currency: input.currency.toUpperCase(),
          entityType: 'supplier-quote',
        },
        rowCount: Math.max(0, p.file.table.length - 1),
        importedCount: 0,
        skippedRows: p.errorRows.length,
        createdBy: actor.userId,
      })
      .returning({ id: dataImport.id })
    const importId = (batch as { id: string }).id
    // 原文件存档（与观测导入一致），便于追溯；存档表也是部署级的
    // 存档只做插入，可放进同一事务；事务对象与 Database 的查询接口一致
    const archived = await createDbArchive(tx as unknown as DecisionActor['db']).put({
      sourceId: QUOTE_IMPORT_SOURCE,
      importId,
      task: { kind: 'import', fileName: input.fileName },
      request: { method: 'UPLOAD', url: `file:${input.fileName}` },
      status: 200,
      body: p.bytes,
      contentType: p.file.contentType,
      fetchedAt: now,
    })

    const s = scoped(tx, actor.workspaceId)
    // 供应商按名称（忽略大小写）复用，没有则新建
    const names = [...new Set(p.resolved.map((r) => r.supplier.name))]
    const existing = await s.select(supplier, {
      where: inArray(
        sql`lower(${supplier.name})`,
        names.map((n) => n.toLowerCase()),
      ),
    })
    const supplierId = new Map(existing.map((x) => [x.name.toLowerCase(), x.id]))
    for (const r of p.resolved) {
      const key = r.supplier.name.toLowerCase()
      if (supplierId.has(key)) continue
      const [created] = await s
        .insert(supplier, {
          name: r.supplier.name,
          url: r.supplier.url,
          platform: r.supplier.platform,
        })
        .returning({ id: supplier.id })
      supplierId.set(key, (created as { id: string }).id)
    }
    await s.insert(
      supplierQuote,
      p.resolved.map((r) => ({
        supplierId: supplierId.get(r.supplier.name.toLowerCase()) as string,
        clusterId: r.clusterId,
        tiers: r.tiers,
        currency: r.currency,
        moq: r.moq,
        weightG: r.weightG,
        dimensions: r.dimensions,
        confidence: r.confidence,
        quotedOn: r.quotedOn,
        procurementDays: r.procurementDays,
        note: r.note,
        source: 'import' as const,
        importId,
        createdBy: actor.userId,
      })),
    )
    for (const clusterId of new Set(p.resolved.map((r) => r.clusterId)))
      await enterCosting(s, await latestLeadOf(s, clusterId), actor.userId, 'quote-import')
    await tx
      .update(dataImport)
      .set({ importedCount: p.resolved.length, rawPayloadId: archived.id })
      .where(eq(dataImport.id, importId))
    return { importId, imported: p.resolved.length, skippedRows: p.errorRows.length }
  })
}

/** 本空间的报价导入批次（其他空间的批次不可见） */
export function ownsQuoteImport(
  row: { sourceId: string; context: Record<string, unknown> },
  workspaceId: string,
) {
  return row.sourceId === QUOTE_IMPORT_SOURCE && row.context.workspaceId === workspaceId
}

/**
 * 撤销报价导入：只删除该批次导入、且仍为导入来源的报价；导入后手工改过的报价已记为手工录入，保留。
 * 被选定组合或已决定线索引用的报价不能删，此时整批撤销失败并说明原因。
 */
export async function revertQuoteImport(actor: DecisionActor, importId: string, now = new Date()) {
  assertWorkbenchWriter(actor)
  return actor.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(dataImport)
      .where(eq(dataImport.id, importId))
      .for('update')
    if (!row || !ownsQuoteImport(row, actor.workspaceId))
      throw new AppError('NOT_FOUND', 'Import not found', { status: 404 })
    if (row.revertedAt) return 0
    const s = scoped(tx, actor.workspaceId)
    const quotes = await s.select(supplierQuote, {
      where: all(eq(supplierQuote.importId, importId), eq(supplierQuote.source, 'import')),
      fields: { id: supplierQuote.id },
    })
    const removed = await removeQuotes(
      s,
      quotes.map((q) => q.id),
    )
    await tx.update(dataImport).set({ revertedAt: now }).where(eq(dataImport.id, importId))
    return removed
  })
}
