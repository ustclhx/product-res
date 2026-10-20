import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { assertNotReadOnly, assertWriter } from './access.ts'

/**
 * 人工抽检（specs/data-accuracy「人工抽检与准确率」）。空间成员可查看与填写；
 * 手动生成与提交（会重新评估部署级主值资格）要求可写空间中的 owner / admin。
 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const amount = z.number().nonnegative().max(1_000_000_000).nullable().optional()

const service = () => import('./accuracy.server.ts')

export const getAccuracy = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ auditId: z.uuid().optional() }))
  .handler(async ({ context, data }) =>
    (await service()).accuracyPage(context.db, context.workspace.id, data.auditId),
  )

export const generateAccuracyAudit = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => {
    assertWriter(context)
    return (await service()).generateNow(context.db, context.workspace.id)
  })

export const saveAccuracyItem = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      itemId: z.uuid(),
      actual: z.object({
        price: amount,
        bought_month: amount,
        review_count: amount,
        rating: z.number().min(0).max(5).nullable().optional(),
        bsr: amount,
        available_quantity: z.boolean().nullable().optional(),
      }),
    }),
  )
  .handler(async ({ context, data }) => {
    assertNotReadOnly(context)
    return (await service()).saveItem(context.db, context.workspace.id, {
      itemId: data.itemId,
      actual: data.actual,
      userId: context.user.id,
    })
  })

export const submitAccuracyAudit = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ auditId: z.uuid() }))
  .handler(async ({ context, data }) => {
    assertWriter(context)
    return (await service()).submit(context.db, context.workspace.id, {
      auditId: data.auditId,
      userId: context.user.id,
    })
  })
