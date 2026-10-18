import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import { costParamInput, logisticsProfileInput } from './inputs.ts'

/** 设置页“物流方案 / 成本参数”；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./settings.server.ts')

export const getCostingSettings = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    ...(await (await service()).costingSettings(actorOf(context))),
    canWrite: canWriteWorkbench(context),
  }))

export const saveLogisticsProfile = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid().optional(), profile: logisticsProfileInput }))
  .handler(async ({ context, data }) =>
    (await service()).saveLogisticsProfile(actorOf(context), data.id, data.profile),
  )

export const removeLogisticsProfile = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteLogisticsProfile(actorOf(context), data.id)
    return { ok: true }
  })

export const saveCostParam = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid().optional(), param: costParamInput }))
  .handler(async ({ context, data }) => {
    await (await service()).saveCostParam(actorOf(context), data.id, data.param)
    return { ok: true }
  })

export const removeCostParam = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    await (await service()).deleteCostParam(actorOf(context), data.id)
    return { ok: true }
  })
