import { requireFreshSession } from '@product-res/auth'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'
import { assertRealSession } from '../admin/impersonation.ts'
import type { TransferActor, TransferDeps } from './transfer.server.ts'

/**
 * 数据流转 Server Functions（add-workspace-data-transfer tasks 4.1 服务端入口，6.2 复制 / 预览 / 目标空间）。
 * 写操作（发起、取消、续跑）在 withWorkspace 之外再做 requireFreshSession 并拒绝模拟登录：
 * 平台管理员不经此入口代为流转（D6）。读操作沿用 withWorkspace 的成员校验。
 */
const service = () => import('./transfer.server.ts')
const slug = z.object({ slug: z.string().min(1).max(64) })
const idempotencyKey = z.string().min(1).max(200)

function deps(): TransferDeps {
  const runtime = getWebRuntime()
  return { db: runtime.db, workflow: runtime.transferWorkflow, config: templateConfig }
}

interface WorkspaceContext {
  user: { id: string }
  session: { id: string }
  workspace: { id: string; isPersonal: boolean }
  member: { role: string }
}

const actorOf = (context: WorkspaceContext, sessionId = context.session.id): TransferActor => ({
  userId: context.user.id,
  sessionId,
  workspace: { id: context.workspace.id, isPersonal: context.workspace.isPersonal },
  role: context.member.role,
})

/** 写操作：实时查库确认会话与封禁状态，并拒绝模拟登录 */
async function freshActor(context: WorkspaceContext): Promise<TransferActor> {
  const { db, auth } = getWebRuntime()
  const fresh = await requireFreshSession({ auth, db, headers: getRequest().headers })
  assertRealSession(fresh.session)
  return actorOf({ ...context, user: { id: fresh.user.id } }, fresh.session.id)
}

export const startWorkspaceUpgrade = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      name: z.string().trim().min(1).max(100),
      newSlug: z.string().min(1).max(64),
      idempotencyKey,
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).startWorkspaceUpgrade(deps(), await freshActor(context), {
      name: data.name,
      slug: data.newSlug,
      idempotencyKey: data.idempotencyKey,
    }),
  )

export const startWorkspaceMove = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      targetWorkspaceId: z.uuid(),
      // 形状与上限由引擎 parseSelection 校验
      selection: z.record(z.string(), z.unknown()),
      idempotencyKey,
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).startWorkspaceMove(deps(), await freshActor(context), {
      targetWorkspaceId: data.targetWorkspaceId,
      selection: data.selection,
      idempotencyKey: data.idempotencyKey,
    }),
  )

export const startWorkspaceCopy = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      targetWorkspaceId: z.uuid(),
      selection: z.record(z.string(), z.unknown()),
      idempotencyKey,
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).startWorkspaceCopy(deps(), await freshActor(context), {
      targetWorkspaceId: data.targetWorkspaceId,
      selection: data.selection,
      idempotencyKey: data.idempotencyKey,
    }),
  )

/** 复制 / 移动对话框：可选目标空间（只读，沿用 withWorkspace 的成员校验） */
export const getTransferTargets = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).transferTargets(deps(), actorOf(context)))

/** 复制 / 移动对话框的预览（不落库）；权限与发起相同，由引擎按 D6 校验 */
export const getTransferPreview = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      kind: z.enum(['copy', 'move']),
      targetWorkspaceId: z.uuid(),
      selection: z.record(z.string(), z.unknown()),
    }),
  )
  .handler(async ({ context, data }) =>
    (await service()).selectiveTransferPreview(deps(), actorOf(context), {
      kind: data.kind,
      targetWorkspaceId: data.targetWorkspaceId,
      selection: data.selection,
    }),
  )

export const getUpgradePreview = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).upgradePreview(deps(), actorOf(context)))

export const getWorkspaceTransfers = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).workspaceTransfers(deps(), actorOf(context)))

export const getWorkspaceTransfer = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ transferId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).workspaceTransferDetail(deps(), actorOf(context), data.transferId),
  )

export const cancelWorkspaceTransfer = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ transferId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).cancelWorkspaceTransfer(deps(), await freshActor(context), data.transferId),
  )

export const retryWorkspaceTransfer = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ transferId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).retryWorkspaceTransfer(deps(), await freshActor(context), data.transferId),
  )

/** /admin/workspaces 详情：只读流转记录 */
export const getAdminWorkspaceTransfers = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).adminWorkspaceTransfers(context.db, data.id),
  )

export const getAdminWorkspaceTransfer = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.uuid(), transferId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).adminWorkspaceTransferDetail(context.db, data.id, data.transferId),
  )
