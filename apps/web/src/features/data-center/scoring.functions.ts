import { SELECTION_DIMENSIONS } from '@product-res/db'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { actorOf } from '../workbench/actor.ts'

/** 评分维度管理：读取要求是空间成员；保存由 service 内的 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./scoring.server.ts')
const weight = z.number().min(0).max(100)

export const getScoringSettings = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).scoringPage(actorOf(context)))

export const saveScoringSettings = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      setting: z.object({
        weights: z.object(
          Object.fromEntries(SELECTION_DIMENSIONS.map((d) => [d, weight])) as Record<
            (typeof SELECTION_DIMENSIONS)[number],
            typeof weight
          >,
        ),
        reverseDimensions: z.array(z.enum(SELECTION_DIMENSIONS)).max(SELECTION_DIMENSIONS.length),
        vetoThreshold: z.number().int().min(0).max(100),
        minDimensions: z.number().int().min(1).max(SELECTION_DIMENSIONS.length),
        hardGates: z.object({ compliance: z.boolean(), timing: z.boolean(), margin: z.boolean() }),
        marginFloorBp: z.number().int().min(0).max(10_000),
      }),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).saveScoring(actorOf(context), data.setting, context.user.id),
  )
