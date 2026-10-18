import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { DIRECTION_MARKETPLACES } from '../follow/marketplaces.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'

/** 品类研究（openspec/changes/add-category-insight tasks 3.1–3.4）；写权限在 service 内检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./category.server.ts')
const aiRuntime = () => import('./ai-runtime.server.ts')

const item = z.string().trim().min(1).max(128)
const studyInput = z.object({
  name: z.string().trim().min(1).max(64),
  marketplace: z.enum(DIRECTION_MARKETPLACES),
  categoryIds: z.array(item).max(50),
  keywords: z.array(item).max(50),
  topN: z.number().int().min(1).max(100),
})

type Ctx = Parameters<typeof actorOf>[0] & {
  user: { id: string }
  workspace: { id: string; slug: string }
}
const categoryActor = (context: Ctx) => ({ ...actorOf(context), userId: context.user.id })

async function insightAi(context: Ctx, studyName: string) {
  return (await aiRuntime()).runtimeInsightAi({
    db: context.db,
    workspaceId: context.workspace.id,
    userId: context.user.id,
    slug: context.workspace.slug,
    title: `品类洞察 · ${studyName}：差评痛点与差异化建议`,
  })
}

export const getCategoryStudies = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    ...(await (await service()).listStudies(actorOf(context))),
    canWrite: canWriteWorkbench(context),
  }))

export const createCategoryStudy = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ study: studyInput }))
  .handler(async ({ context, data }) =>
    (await service()).createStudy(categoryActor(context), data.study, {
      ai: await insightAi(context, data.study.name),
    }),
  )

export const updateCategoryStudy = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), study: studyInput }))
  .handler(async ({ context, data }) => {
    await (await service()).updateStudy(categoryActor(context), data.id, data.study)
    return { ok: true }
  })

export const refreshCategoryStudy = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), name: z.string().max(64) }))
  .handler(async ({ context, data }) =>
    (await service()).refreshStudy(categoryActor(context), data.id, {
      ai: await insightAi(context, data.name),
    }),
  )

export const archiveCategoryStudy = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), archived: z.boolean() }))
  .handler(async ({ context, data }) => {
    await (await service()).setStudyArchived(categoryActor(context), data.id, data.archived)
    return { ok: true }
  })

export const getCategoryReport = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), snapshotId: z.uuid().optional() }))
  .handler(async ({ context, data }) => ({
    ...(await (await service()).reportPage(actorOf(context), data.id, data.snapshotId)),
    canWrite: canWriteWorkbench(context),
  }))

export const convertCategoryProduct = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      studyId: z.uuid(),
      snapshotId: z.uuid(),
      productId: z.uuid(),
      directionId: z.uuid().optional(),
      improvement: z.string().trim().max(500),
    }),
  )
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await service()).convertToLead(categoryActor(context), input)
  })
