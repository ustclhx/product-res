import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import {
  FOLLOW_MODES,
  improvementInput,
  matrixOptions,
  quoteInput,
  scenarioPick,
  supplierInput,
} from './inputs.ts'

/**
 * 商品簇详情“核算”标签（tasks 2.3 / 3.1）与数据中心报价导入；读取要求空间成员，
 * 写权限在 service 内由 assertWorkbenchWriter 检查，核算锁定由 assertCostingEditable 检查。
 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const quotes = () => import('./quotes.server.ts')
const matrix = () => import('./matrix.server.ts')
const imports = () => import('./quote-import.server.ts')

const actor = (context: Parameters<typeof actorOf>[0] & { user: { id: string } }) => ({
  ...actorOf(context),
  userId: context.user.id,
})

export const getCostingTab = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({ clusterId: z.uuid(), leadId: z.uuid().nullable(), options: matrixOptions }),
  )
  .handler(async ({ context, data }) => {
    const a = { ...actorOf(context), canWrite: canWriteWorkbench(context) }
    const [q, view] = await Promise.all([
      (await quotes()).clusterQuotes(a, data.clusterId),
      data.leadId ? (await matrix()).costingView(a, data.leadId, data.options) : null,
    ])
    return { ...q, view, canWrite: a.canWrite }
  })

export const saveSupplier = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid().optional(), supplier: supplierInput }))
  .handler(async ({ context, data }) => {
    const row = await (await quotes()).saveSupplier(actor(context), data.id, data.supplier)
    return { id: row.id }
  })

export const removeSupplier = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await quotes()).deleteSupplier(actor(context), data.id)
    return { ok: true }
  })

export const saveQuote = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ clusterId: z.uuid(), id: z.uuid().optional(), quote: quoteInput }))
  .handler(async ({ context, data }) =>
    (await quotes()).saveQuote(actor(context), data.clusterId, data.id, data.quote),
  )

export const removeQuote = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ clusterId: z.uuid(), id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await quotes()).deleteQuote(actor(context), data.clusterId, data.id)
    return { ok: true }
  })

export const selectScenario = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ leadId: z.uuid(), pick: scenarioPick, options: matrixOptions }))
  .handler(async ({ context, data }) =>
    (await matrix()).selectScenario(actor(context), data.leadId, data.pick, data.options),
  )

export const setFollowMode = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ leadId: z.uuid(), mode: z.enum(FOLLOW_MODES) }))
  .handler(async ({ context, data }) =>
    (await matrix()).setFollowMode(actor(context), data.leadId, data.mode),
  )

export const saveImprovement = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ leadId: z.uuid(), improvement: improvementInput }))
  .handler(async ({ context, data }) =>
    (await matrix()).saveImprovement(actor(context), data.leadId, data.improvement),
  )

// ---- 数据中心：供应商报价导入 ----

const quoteImportInput = slug.extend({
  fileName: z.string().min(1).max(255),
  // 5 MB 文件的 base64 约 6.7 MB
  contentBase64: z.string().min(1).max(7_200_000),
  sheetName: z.string().min(1).max(255).optional(),
  marketplace: z.enum(['ebay-us', 'amazon-us', 'amazon-uk', 'amazon-de', 'amazon-jp', 'amazon-ca']),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
})

export const previewQuoteImport = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(quoteImportInput)
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await imports()).previewQuoteImport(actor(context), input)
  })

export const commitQuoteImport = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    quoteImportInput.extend({
      skipErrorRows: z.boolean().default(false),
      confirmDuplicate: z.boolean().default(false),
    }),
  )
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await imports()).commitQuoteImport(actor(context), input)
  })
