import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { canWriteWorkbench } from '../workbench/access.ts'
import { actorOf } from '../workbench/actor.ts'
import { PLATFORMS } from './candidates.ts'

/**
 * 跟卖候选列表与商品簇详情（specs/follow-candidates）。读取要求空间成员；
 * 拆分、合并与人工刷新在 service 内由 assertWorkbenchWriter 检查。
 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const reads = () => import('./candidates.server.ts')
const writes = () => import('./clusters.server.ts')

export const getCandidates = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      platform: z.enum(PLATFORMS),
      direction: z.uuid().optional(),
      offset: z.number().int().min(0).max(100_000),
    }),
  )
  .handler(async ({ context, data }) =>
    (await reads()).candidatesPage(actorOf(context), {
      platform: data.platform,
      ...(data.direction ? { direction: data.direction } : {}),
      offset: data.offset,
    }),
  )

export const getClusterDetail = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ clusterId: z.string().min(1).max(64) }))
  .handler(async ({ context, data }) =>
    (await reads()).clusterDetail(actorOf(context), data.clusterId, canWriteWorkbench(context)),
  )

export const splitMember = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ clusterId: z.uuid(), memberId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await writes()).splitClusterMember(actorOf(context), {
      clusterId: data.clusterId,
      memberId: data.memberId,
      actorUserId: context.user.id,
    }),
  )

export const mergeCluster = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ intoClusterId: z.uuid(), fromClusterId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await writes()).mergeIntoCluster(actorOf(context), {
      intoClusterId: data.intoClusterId,
      fromClusterId: data.fromClusterId,
      actorUserId: context.user.id,
    }),
  )

export const estimateMemberRefresh = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ clusterId: z.uuid(), memberId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await writes()).memberRefreshOptions(actorOf(context), {
      clusterId: data.clusterId,
      memberId: data.memberId,
    }),
  )

export const refreshMemberData = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({ clusterId: z.uuid(), memberId: z.uuid(), sourceId: z.string().min(1).max(64) }),
  )
  .handler(async ({ context, data }) =>
    (await writes()).refreshMember(actorOf(context), {
      clusterId: data.clusterId,
      memberId: data.memberId,
      sourceId: data.sourceId,
    }),
  )
