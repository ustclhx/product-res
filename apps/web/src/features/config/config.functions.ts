import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { DIRECTION_MARKETPLACES } from '../follow/marketplaces.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import { BRAND_KINDS, RULE_KINDS, RULE_LEVELS } from './labels.ts'

/** 设置页（节点日历、品牌库、风险规则）；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./config.server.ts')
const item = z.string().trim().min(1).max(128)

export const getConfigPage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    ...(await (await service()).configPage(actorOf(context))),
    canWrite: canWriteWorkbench(context),
  }))

export const saveSeasonalNode = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      id: z.uuid().optional(),
      node: z.object({
        name: z.string().trim().min(1).max(64),
        startMonth: z.number().int().min(1).max(12),
        startDay: z.number().int().min(1).max(31),
        salesDays: z.number().int().min(1).max(366),
        keywords: z.array(item).max(50),
      }),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).saveNode(actorOf(context), data.id, data.node),
  )

export const removeSeasonalNode = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteNode(actorOf(context), data.id)
    return { ok: true }
  })

export const saveBrandEntry = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      id: z.uuid().optional(),
      brand: z.object({
        name: z.string().trim().min(1).max(128),
        kind: z.enum(BRAND_KINDS),
        marketplace: z.enum(DIRECTION_MARKETPLACES).nullish(),
        note: z.string().max(500).nullish(),
      }),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).saveBrand(actorOf(context), data.id, data.brand),
  )

export const removeBrandEntry = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteBrand(actorOf(context), data.id)
    return { ok: true }
  })

export const saveRiskRule = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      id: z.uuid().optional(),
      rule: z.object({
        kind: z.enum(RULE_KINDS),
        level: z.enum(RULE_LEVELS),
        description: z.string().trim().min(1).max(500),
        enabled: z.boolean(),
        match: z.object({
          categoryIds: z.array(item).max(50),
          keywords: z.array(item).max(100),
          marketplaces: z.array(z.enum(DIRECTION_MARKETPLACES)).max(DIRECTION_MARKETPLACES.length),
        }),
      }),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).saveRule(actorOf(context), data.id, data.rule),
  )

export const removeRiskRule = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteRule(actorOf(context), data.id)
    return { ok: true }
  })
