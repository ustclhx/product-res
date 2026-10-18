import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import { DIRECTION_MARKETPLACES } from './marketplaces.ts'

/** 选品方向与对标店铺池（specs/selection-directions）；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./directions.server.ts')

const item = z.string().trim().min(1).max(128)
const directionInput = z.object({
  name: z.string().trim().min(1).max(64),
  marketplaces: z.array(z.enum(DIRECTION_MARKETPLACES)).min(1).max(DIRECTION_MARKETPLACES.length),
  categoryIds: z.array(item).max(50),
  keywords: z.array(item).max(100),
  nodeIds: z.array(z.uuid()).max(50),
  note: z.string().max(500).nullish(),
})

export const getDirectionsPage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    ...(await (await service()).directionsPage(actorOf(context))),
    canWrite: canWriteWorkbench(context),
  }))

export const saveDirection = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid().optional(), direction: directionInput }))
  .handler(async ({ context, data }) => {
    const s = await service()
    return data.id
      ? s.updateDirection(actorOf(context), data.id, data.direction)
      : s.createDirection(actorOf(context), data.direction)
  })

export const toggleDirection = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), enabled: z.boolean() }))
  .handler(async ({ context, data }) =>
    (await service()).setDirectionEnabled(actorOf(context), data.id, data.enabled),
  )

export const removeDirection = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteDirection(actorOf(context), data.id)
    return { ok: true }
  })

export const addDirectionSeller = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      directionId: z.uuid(),
      marketplace: z.enum(DIRECTION_MARKETPLACES),
      sellerPlatformId: z.string().trim().min(1).max(128),
      sellerName: z.string().trim().max(128).nullish(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await service()).addSeedSeller(actorOf(context), input)
  })

export const reviewDirectionSeller = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), decision: z.enum(['accept', 'reject']) }))
  .handler(async ({ context, data }) =>
    (await service()).reviewSuggestedSeller(actorOf(context), data.id, data.decision),
  )

export const removeDirectionSeller = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).removeSeller(actorOf(context), data.id)
    return { ok: true }
  })
