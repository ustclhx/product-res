import {
  buildImport,
  type ColumnMapping,
  type DATA_KINDS,
  type ImportContext,
  METRICS,
  parseCsv,
  type SourceConnector,
  suggestMapping,
} from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { dataImport, observation, rawPayload, syncRun } from '@product-res/db/schema'
import {
  commitImport,
  createDbArchive,
  credentialStatus,
  currentUsage,
  effectiveBudget,
  ensureSources,
  listImports,
  listIssues,
  listRuns,
  listSources,
  listTemplates,
  revertImport,
  runSyncTask,
  type SourceConfig,
  saveProbe,
  saveTemplate,
  setIssueStatus,
  setSourceEnabled,
  updateSourceConfig,
} from '@product-res/marketdata'
import { AppError } from '@product-res/shared'
import { and, count, desc, eq, gte, isNull } from 'drizzle-orm'
import { webConnectors, webSecrets } from './registry.server.ts'

/** “今天”按新加坡时间（团队所在时区）计算 */
function todayStartSgt(now: Date) {
  const sgt = new Date(now.getTime() + 8 * 3_600_000)
  return new Date(
    Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate()) - 8 * 3_600_000,
  )
}

function connectorOrThrow(sourceId: string): SourceConnector {
  const connector = webConnectors().get(sourceId)
  if (!connector) throw new AppError('NOT_FOUND', 'Data source not found', { status: 404 })
  return connector
}

export async function dataCenterOverview(db: Database, now = new Date()) {
  const registry = webConnectors()
  await ensureSources(db, registry.all())
  const rows = new Map((await listSources(db)).map((r) => [r.id, r]))
  const secret = await webSecrets().catch(() => () => undefined)
  const sources = await Promise.all(
    registry.all().map(async (connector) => {
      const row = rows.get(connector.id)
      const spec = effectiveBudget(connector, row?.config as SourceConfig | undefined)
      const [records] = await db
        .select({ value: count() })
        .from(observation)
        .where(eq(observation.sourceId, connector.id))
      const [last] = await db
        .select()
        .from(syncRun)
        .where(eq(syncRun.sourceId, connector.id))
        .orderBy(desc(syncRun.startedAt))
        .limit(1)
      return {
        id: connector.id,
        label: connector.label,
        access: connector.access,
        marketplaces: connector.marketplaces,
        capabilities: connector.capabilities,
        enabled: row?.enabled ?? false,
        paused: row?.pausedReason
          ? { reason: row.pausedReason, until: row.pausedUntil?.toISOString() ?? null }
          : null,
        credentials: credentialStatus(connector, secret, row),
        config: (row?.config ?? {}) as SourceConfig,
        budget: await currentUsage(db, connector.id, spec, now).then((usage) => ({
          ...usage,
          resetsAt: usage.resetsAt.toISOString(),
          period: spec.period,
        })),
        hardCapEditable: connector.budget.hardCapEditable ?? false,
        records: records?.value ?? 0,
        lastRun: last
          ? {
              id: last.id,
              status: last.status,
              startedAt: last.startedAt.toISOString(),
              finishedAt: last.finishedAt?.toISOString() ?? null,
              errorCode: last.errorCode,
            }
          : null,
      }
    }),
  )
  const [records] = await db.select({ value: count() }).from(observation)
  const [runsToday] = await db
    .select({ value: count() })
    .from(syncRun)
    .where(gte(syncRun.startedAt, todayStartSgt(now)))
  const [imports] = await db
    .select({ value: count() })
    .from(dataImport)
    .where(isNull(dataImport.revertedAt))
  return {
    kpis: {
      enabledSources: sources.filter((s) => s.enabled).length,
      totalSources: sources.length,
      records: records?.value ?? 0,
      runsToday: runsToday?.value ?? 0,
      imports: imports?.value ?? 0,
    },
    sources,
  }
}

export async function updateSource(
  db: Database,
  input: {
    sourceId: string
    enabled?: boolean
    safetyLine?: number
    hardCap?: number
    schedule?: string
  },
) {
  const connector = connectorOrThrow(input.sourceId)
  await ensureSources(db, [connector])
  if (input.enabled !== undefined) await setSourceEnabled(db, connector.id, input.enabled)
  const patch: SourceConfig = {
    ...(input.safetyLine === undefined ? {} : { safetyLine: input.safetyLine }),
    ...(input.hardCap === undefined ? {} : { hardCap: input.hardCap }),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
  }
  if (Object.keys(patch).length > 0) await updateSourceConfig(db, connector, patch)
  return { ok: true }
}

export async function probeSource(db: Database, sourceId: string) {
  const connector = connectorOrThrow(sourceId)
  const secret = await webSecrets()
  const receipt = await connector.probe({ fetch, secret, now: () => new Date() })
  await ensureSources(db, [connector])
  await saveProbe(db, receipt)
  return receipt
}

/** 人工刷新：显示预计花费后同步执行一次，遵守额度规则（可用到硬上限） */
export async function refreshNow(
  db: Database,
  input: {
    sourceId: string
    kind: (typeof DATA_KINDS)[number]
    marketplace: string
    ids: string[]
  },
) {
  const connector = connectorOrThrow(input.sourceId)
  if (!connector.marketplaces.includes(input.marketplace as never))
    throw new AppError('INVALID_INPUT', '该数据源不支持此站点', { status: 400 })
  const task = {
    kind: input.kind,
    marketplace: input.marketplace as SourceConnector['marketplaces'][number],
    scope: { ids: input.ids },
  }
  const outcome = await runSyncTask(
    {
      db,
      archive: createDbArchive(db),
      ctx: { fetch, secret: await webSecrets(), now: () => new Date() },
    },
    connector,
    task,
    { mode: 'manual', trigger: 'manual' },
  )
  if (outcome.status === 'failed')
    return { status: outcome.status, runId: outcome.runId, errorCode: outcome.error.code }
  if (outcome.status === 'deferred')
    return {
      status: outcome.status,
      runId: outcome.runId,
      reason: outcome.reason,
      resetsAt: outcome.resetsAt.toISOString(),
    }
  return outcome.status === 'succeeded'
    ? { status: outcome.status, runId: outcome.runId, observations: outcome.observations }
    : { status: outcome.status, runId: outcome.runId, reason: outcome.reason }
}

export function estimateRefresh(input: {
  sourceId: string
  kind: (typeof DATA_KINDS)[number]
  marketplace: string
  ids: string[]
}) {
  const connector = connectorOrThrow(input.sourceId)
  return connector.plan({
    kind: input.kind,
    marketplace: input.marketplace as never,
    scope: { ids: input.ids },
  })
}

export async function syncRuns(db: Database, filter: { sourceId?: string; failedOnly?: boolean }) {
  const rows = await listRuns(db, {
    ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
    ...(filter.failedOnly ? { status: 'failed' as const } : {}),
    limit: 100,
  })
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    dataKind: r.dataKind,
    marketplace: r.marketplace,
    scope: JSON.stringify(r.scope),
    trigger: r.trigger,
    status: r.status,
    planned: r.planned,
    calls: r.calls,
    cost: r.cost,
    okCount: r.okCount,
    failCount: r.failCount,
    errorCode: r.errorCode,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }))
}

/** 失败任务重新执行（人工触发，遵守额度规则） */
export async function retryRun(db: Database, runId: string) {
  const [run] = await db.select().from(syncRun).where(eq(syncRun.id, runId))
  if (!run) throw new AppError('NOT_FOUND', 'Run not found', { status: 404 })
  const connector = connectorOrThrow(run.sourceId)
  const { cursor, ...scope } = run.scope as Record<string, unknown>
  const outcome = await runSyncTask(
    {
      db,
      archive: createDbArchive(db),
      ctx: { fetch, secret: await webSecrets(), now: () => new Date() },
    },
    connector,
    {
      kind: run.dataKind as (typeof DATA_KINDS)[number],
      marketplace: run.marketplace as SourceConnector['marketplaces'][number],
      scope,
      ...(typeof cursor === 'string' ? { cursor } : {}),
    },
    { mode: 'manual', trigger: 'manual' },
  )
  return { status: outcome.status, runId: outcome.runId }
}

/** 数据预览：最近一次存档响应的 JSON / 表格 / Schema / 原始四种视图；原始视图不含凭据 */
export async function previewSource(db: Database, sourceId: string) {
  const connector = connectorOrThrow(sourceId)
  const [meta] = await db
    .select()
    .from(rawPayload)
    .where(
      and(
        eq(rawPayload.sourceId, sourceId),
        isNull(rawPayload.importId),
        isNull(rawPayload.purgedAt),
      ),
    )
    .orderBy(desc(rawPayload.fetchedAt))
    .limit(1)
  if (!meta) return null
  const stored = await createDbArchive(db).get(meta.id)
  if (!stored) return null
  const body = new TextDecoder().decode(stored.body)
  let json: string | null = null
  try {
    json = JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    json = null
  }
  const batch = connector.normalize({
    sourceId,
    task: meta.task as never,
    request: meta.request,
    status: meta.status,
    body,
    fetchedAt: meta.fetchedAt.toISOString(),
  })
  const metrics = [...new Set(batch.observations.map((o) => o.metric))]
  return {
    fetchedAt: meta.fetchedAt.toISOString(),
    request: meta.request,
    status: meta.status,
    bytes: meta.bytes,
    raw: body.length > 200_000 ? `${body.slice(0, 200_000)}\n…（已截断）` : body,
    json,
    rows: batch.observations.slice(0, 200).map((o) => ({
      platformId: o.entity.platformId,
      marketplace: o.entity.marketplace,
      metric: o.metric,
      observedOn: o.observedOn,
      value: o.value,
      currency: o.currency ?? null,
      method: o.method,
    })),
    schema: metrics.map((name) => {
      const def = METRICS[name as keyof typeof METRICS]
      return {
        name,
        label: def?.label ?? name,
        unit: def?.unit ?? 'unknown',
        entity: def?.entity ?? 'unknown',
        method: batch.observations.find((o) => o.metric === name)?.method ?? 'official',
      }
    }),
  }
}

export async function qualityIssues(
  db: Database,
  status?: 'open' | 'known' | 'ignored' | 'resolved',
) {
  const rows = await listIssues(db, { ...(status ? { status } : {}), limit: 200 })
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    sourceId: r.sourceId,
    entityType: r.entityType,
    entityId: r.entityId,
    metric: r.metric,
    detail: JSON.stringify(r.detail),
    status: r.status,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }))
}

export const updateIssue = (
  db: Database,
  id: string,
  status: 'open' | 'known' | 'ignored' | 'resolved',
) => setIssueStatus(db, id, status)

// —— 文件导入 ——

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export interface ImportRequest {
  readonly sourceId: string
  readonly fileName: string
  /** 文件内容（base64） */
  readonly contentBase64: string
  readonly context: Omit<ImportContext, 'sourceId'>
  readonly mapping?: ColumnMapping
  readonly templateId?: string
}

function decodeFile(input: ImportRequest) {
  const bytes = Uint8Array.from(atob(input.contentBase64), (c) => c.charCodeAt(0))
  if (bytes.byteLength > MAX_IMPORT_BYTES)
    throw new AppError('IMPORT_TOO_LARGE', '文件超过 5 MB', { status: 413 })
  if (!/\.(csv|tsv|txt)$/i.test(input.fileName))
    throw new AppError('IMPORT_UNSUPPORTED', '目前支持 CSV / TSV；Excel 请先另存为 CSV', {
      status: 400,
    })
  return bytes
}

async function parseImport(db: Database, input: ImportRequest) {
  const bytes = decodeFile(input)
  const table = parseCsv(new TextDecoder().decode(bytes))
  const [headers = [], ...rows] = table
  const templates = await listTemplates(db, input.sourceId)
  const template = input.templateId ? templates.find((t) => t.id === input.templateId) : undefined
  const suggestion = suggestMapping(
    headers,
    (template?.mapping as ColumnMapping | undefined) ?? undefined,
  )
  const mapping = input.mapping ?? suggestion.mapping
  const context: ImportContext = { ...input.context, sourceId: input.sourceId }
  const preview = buildImport(headers, rows, mapping, context)
  return {
    bytes,
    headers,
    rows,
    mapping,
    unmatched: suggestion.unmatched,
    preview,
    context,
    template,
  }
}

export async function previewImport(db: Database, input: ImportRequest) {
  const parsed = await parseImport(db, input)
  return {
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 50),
    mapping: parsed.mapping,
    unmatched: parsed.unmatched,
    rowCount: parsed.preview.rowCount,
    observationCount: parsed.preview.observations.length,
    entityCount: parsed.preview.entities.length,
    issues: parsed.preview.issues.slice(0, 200),
    errorRows: parsed.preview.errorRows,
  }
}

export async function confirmImport(
  db: Database,
  input: ImportRequest & {
    skipErrorRows: boolean
    confirmDuplicate: boolean
    saveTemplateName?: string
    userId: string
  },
) {
  const parsed = await parseImport(db, input)
  const saved = input.saveTemplateName
    ? await saveTemplate(db, {
        sourceId: input.sourceId,
        name: input.saveTemplateName,
        mapping: parsed.mapping,
        defaults: {
          marketplace: parsed.context.marketplace,
          entityType: parsed.context.entityType,
        },
      })
    : undefined
  const templateId = saved?.id ?? parsed.template?.id
  return commitImport(db, createDbArchive(db), {
    fileName: input.fileName,
    file: parsed.bytes,
    contentType: 'text/csv',
    context: parsed.context,
    preview: parsed.preview,
    skipErrorRows: input.skipErrorRows,
    confirmDuplicate: input.confirmDuplicate,
    ...(templateId ? { templateId } : {}),
    userId: input.userId,
    now: new Date(),
  })
}

export async function importHistory(db: Database) {
  const rows = await listImports(db, 50)
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    fileName: r.fileName,
    rowCount: r.rowCount,
    importedCount: r.importedCount,
    skippedRows: r.skippedRows,
    context: JSON.stringify(r.context),
    createdAt: r.createdAt.toISOString(),
    revertedAt: r.revertedAt?.toISOString() ?? null,
  }))
}

export const undoImport = (db: Database, importId: string) => revertImport(db, importId, new Date())

export async function importTemplates(db: Database, sourceId?: string) {
  const rows = await listTemplates(db, sourceId)
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    name: r.name,
    mapping: r.mapping as ColumnMapping,
  }))
}

/** 可作为导入来源的数据源：注册表中的数据源 + 只能导入的工具 */
export function importSources() {
  const registered = webConnectors()
    .all()
    .map((c) => ({ id: c.id, label: c.label }))
  const fileOnly = [
    { id: 'helium10', label: 'Helium 10（导出文件）' },
    { id: 'jungle-scout', label: 'Jungle Scout（导出文件）' },
    { id: 'sellersprite', label: '卖家精灵（导出文件）' },
    { id: 'terapeak', label: 'Terapeak（导出文件）' },
    { id: 'supplier-quote', label: '供应商报价表' },
  ]
  const seen = new Set(registered.map((r) => r.id))
  return [...registered, ...fileOnly.filter((f) => !seen.has(f.id))]
}
