import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import { decisionInput, outcomeInput } from './inputs.ts'

/** 工作台首页、决定与选品档案库；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const decisions = () => import('./decisions.server.ts')
const archive = () => import('./archive.server.ts')

const decisionActor = (context: Parameters<typeof actorOf>[0] & { user: { id: string } }) => ({
  ...actorOf(context),
  userId: context.user.id,
})

export const getWorkbenchHome = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    ...(await (await decisions()).workbenchHome(actorOf(context))),
    canWrite: canWriteWorkbench(context),
  }))

export const decideLead = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ leadId: z.uuid(), decision: decisionInput }))
  .handler(async ({ context, data }) =>
    (await decisions()).decideLead(decisionActor(context), data.leadId, data.decision),
  )

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const archiveFilters = z.object({
  platform: z.enum(['amazon', 'ebay']).optional(),
  directionId: z.uuid().optional(),
  kind: z.enum(['follow', 'drop']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
})
export type ArchiveSearch = z.infer<typeof archiveFilters>

export const getArchivePage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ filters: archiveFilters }))
  .handler(async ({ context, data }) => ({
    ...(await (await archive()).archivePage(actorOf(context), data.filters)),
    canWrite: canWriteWorkbench(context),
  }))

export const getDecisionDetail = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => (await archive()).decisionDetail(actorOf(context), data.id))

export const saveFollowOutcome = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ decisionId: z.uuid(), outcome: outcomeInput }))
  .handler(async ({ context, data }) =>
    (await archive()).recordOutcome(decisionActor(context), data.decisionId, data.outcome),
  )
