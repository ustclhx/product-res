import { DATA_KINDS } from '@product-res/datasources'
import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'

/**
 * 数据中心（specs/data-center）。市场数据是部署级共享数据：读取要求是空间成员，
 * 修改数据源配置、触发同步和导入要求可写空间中的 owner / admin。
 */
const slug = z.object({ slug: z.string().min(1).max(64) })

function assertWriter(context: { workspaceReadOnly: boolean; member: { role: string } }) {
  if (context.workspaceReadOnly)
    throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })
  if (context.member.role !== 'owner' && context.member.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only owners and admins can change data sources', {
      status: 403,
    })
}

const service = () => import('./service.server.ts')

export const getDataCenter = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).dataCenterOverview(context.db))

export const saveDataSource = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      sourceId: z.string().min(1).max(64),
      enabled: z.boolean().optional(),
      safetyLine: z.number().int().min(0).max(1_000_000_000).optional(),
      hardCap: z.number().int().min(0).max(1_000_000_000).optional(),
      schedule: z.string().max(64).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).updateSource(context.db, {
      sourceId: data.sourceId,
      ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
      ...(data.safetyLine === undefined ? {} : { safetyLine: data.safetyLine }),
      ...(data.hardCap === undefined ? {} : { hardCap: data.hardCap }),
      ...(data.schedule === undefined ? {} : { schedule: data.schedule }),
    })
  })

export const probeDataSource = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ sourceId: z.string().min(1).max(64) }))
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).probeSource(context.db, data.sourceId)
  })

const refreshInput = slug.extend({
  sourceId: z.string().min(1).max(64),
  kind: z.enum(DATA_KINDS),
  marketplace: z.string().min(1).max(32),
  ids: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
})

export const estimateDataRefresh = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(refreshInput)
  .handler(async ({ data }) => ({ cost: (await service()).estimateRefresh(data) }))

export const refreshData = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(refreshInput)
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).refreshNow(context.db, data)
  })

export const getSyncRuns = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      sourceId: z.string().max(64).optional(),
      failedOnly: z.boolean().default(false),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).syncRuns(context.db, {
      ...(data.sourceId ? { sourceId: data.sourceId } : {}),
      failedOnly: data.failedOnly,
    }),
  )

export const retrySyncRun = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ runId: z.uuid() }))
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).retryRun(context.db, data.runId)
  })

export const getDataPreview = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ sourceId: z.string().min(1).max(64) }))
  .handler(async ({ context, data }) => (await service()).previewSource(context.db, data.sourceId))

const issueStatus = z.enum(['open', 'known', 'ignored', 'resolved'])

export const getQualityIssues = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ status: issueStatus.optional() }))
  .handler(async ({ context, data }) => (await service()).qualityIssues(context.db, data.status))

export const setQualityIssueStatus = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), status: issueStatus }))
  .handler(async ({ context, data }) => {
    assertWriter(context)
    await (await service()).updateIssue(context.db, data.id, data.status)
    return { ok: true }
  })

const columnTarget = z.union([
  z.object({
    kind: z.enum(['platformId', 'title', 'brand', 'gtin', 'url', 'observedOn', 'ignore']),
  }),
  z.object({
    kind: z.literal('metric'),
    metric: z.string().min(1).max(64),
    currency: z.string().length(3).optional(),
  }),
])

const importInput = slug.extend({
  sourceId: z.string().min(1).max(64),
  fileName: z.string().min(1).max(255),
  // 5 MB 文件的 base64 约 6.7 MB
  contentBase64: z.string().min(1).max(7_200_000),
  context: z.object({
    marketplace: z.enum([
      'ebay-us',
      'amazon-us',
      'amazon-uk',
      'amazon-de',
      'amazon-jp',
      'amazon-ca',
      'global',
    ]),
    entityType: z.enum(['product', 'seller', 'keyword']),
    observedOn: z.iso.date().optional(),
    currency: z.string().length(3).optional(),
  }),
  mapping: z.record(z.string().max(255), columnTarget).optional(),
  templateId: z.uuid().optional(),
})

function importRequest(data: z.infer<typeof importInput>) {
  const { slug: _slug, mapping, templateId, ...rest } = data
  return {
    ...rest,
    context: {
      marketplace: rest.context.marketplace,
      entityType: rest.context.entityType,
      ...(rest.context.observedOn ? { observedOn: rest.context.observedOn } : {}),
      ...(rest.context.currency ? { currency: rest.context.currency } : {}),
    },
    ...(mapping ? { mapping: mapping as never } : {}),
    ...(templateId ? { templateId } : {}),
  }
}

export const previewDataImport = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(importInput)
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).previewImport(context.db, importRequest(data))
  })

export const commitDataImport = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    importInput.extend({
      skipErrorRows: z.boolean().default(false),
      confirmDuplicate: z.boolean().default(false),
      saveTemplateName: z.string().trim().min(1).max(64).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    assertWriter(context)
    const { skipErrorRows, confirmDuplicate, saveTemplateName, ...rest } = data
    return (await service()).confirmImport(context.db, {
      ...importRequest(rest),
      skipErrorRows,
      confirmDuplicate,
      ...(saveTemplateName ? { saveTemplateName } : {}),
      userId: context.user.id,
    })
  })

export const getImports = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => {
    const s = await service()
    return {
      history: await s.importHistory(context.db),
      templates: await s.importTemplates(context.db),
      sources: s.importSources(),
    }
  })

export const revertDataImport = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ importId: z.uuid() }))
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return { removed: await (await service()).undoImport(context.db, data.importId) }
  })
