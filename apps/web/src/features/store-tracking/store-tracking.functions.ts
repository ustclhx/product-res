import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { transferAvailability } from '../transfer/availability.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'

/** 店铺追踪（specs/store-tracking）；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./store-tracking.server.ts')

const settings = z.object({
  kind: z.enum(['benchmark', 'hot', 'watch']),
  directionIds: z.array(z.uuid()).max(50),
  keywords: z.array(z.string().trim().min(1).max(128)).max(5),
  displayName: z.string().trim().max(128).nullish(),
  reason: z.string().trim().max(500).nullish(),
})

export const getStoresPage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => {
    const s = await service()
    const transfer = transferAvailability(context, templateConfig)
    const [page, trackedProducts] = await Promise.all([
      s.storesPage(actorOf(context)),
      // 追踪商品列表只用于选择复制 / 移动（add-workspace-data-transfer 6.2），流转不可用时不查询
      transfer.copy || transfer.move ? s.trackedProductList(actorOf(context)) : null,
    ])
    return {
      ...page,
      trackedProducts,
      canWrite: canWriteWorkbench(context),
      transfer,
      roundAvailable: getWebRuntime().storeTrackingQueue?.available === true,
    }
  })

export const getStoreDetail = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid() }))
  .handler(async ({ context, data }) => ({
    ...(await (await service()).storeDetail(actorOf(context), data.id)),
    canWrite: canWriteWorkbench(context),
  }))

/** 粘贴链接后的解析预览（不写库） */
export const parseStoreUrl = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ url: z.string().max(2048) }))
  .handler(async ({ data }) => (await service()).previewStoreLink(data.url))

export const addTrackedStore = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ url: z.string().max(2048), ...settings.shape }))
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await service()).createTrackedStore(actorOf(context), input)
  })

export const updateTrackedStore = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), ...settings.shape }))
  .handler(async ({ context, data }) => {
    const { slug: _slug, id, ...input } = data
    return (await service()).saveTrackedStore(actorOf(context), id, input)
  })

export const setTrackedStoreStatus = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), status: z.enum(['active', 'paused', 'removed']) }))
  .handler(async ({ context, data }) =>
    (await service()).changeStoreStatus(actorOf(context), data.id, data.status),
  )

/** 立即跑一轮店铺追踪（本空间；流水线暂停时也可用） */
export const runStoreRound = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) =>
    (await service()).requestStoreRound(actorOf(context), getWebRuntime().storeTrackingQueue),
  )
