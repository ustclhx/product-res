import { grant, revokeGrant } from '@product-res/credits'
import { auditLog, organization } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminActionScope } from './action.ts'

export const creditAdjustmentInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('grant'),
    adjustmentId: z.uuid(),
    workspaceId: z.uuid(),
    amount: z.number().int().positive().max(2_147_483_647),
    expiresAt: z.iso.datetime().nullable(),
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    kind: z.literal('revoke'),
    adjustmentId: z.uuid(),
    workspaceId: z.uuid(),
    grantId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
  }),
])

/** 调整 ID 锁跨空间串行化重试；原始审计绑定参数，失败时积分与审计一起回滚。 */
export async function adjustAdminCredits(
  { tx, audit }: AdminActionScope,
  data: z.infer<typeof creditAdjustmentInput>,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`admin-credit:${data.adjustmentId}`}, 0))`,
  )
  const [existing] = await tx
    .select()
    // biome-ignore lint/plugin: Platform-admin adjustment IDs are globally bound to their original workspace and input.
    .from(auditLog)
    .where(and(eq(auditLog.action, 'credits.adjust'), eq(auditLog.targetId, data.adjustmentId)))
  if (existing) {
    const saved = (existing.meta as { input: Record<string, unknown> }).input
    if (!saved || Object.entries(data).some(([key, value]) => saved[key] !== value))
      throw new AppError('ADJUSTMENT_ID_CONFLICT', 'Adjustment ID already used')
    await audit({
      action: 'credits.adjust_replayed',
      targetType: 'credit_adjustment',
      targetId: data.adjustmentId,
      workspaceId: data.workspaceId,
    })
    return { replayed: true }
  }
  const [workspace] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, data.workspaceId))
  if (!workspace) throw new AppError('WORKSPACE_NOT_FOUND', 'Workspace not found', { status: 404 })
  const result =
    data.kind === 'grant'
      ? await grant(tx, {
          workspaceId: data.workspaceId,
          source: 'admin',
          sourceRef: data.adjustmentId,
          amount: data.amount,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        })
      : await revokeGrant(tx, { workspaceId: data.workspaceId, grantId: data.grantId })
  await audit({
    action: 'credits.adjust',
    targetType: 'credit_adjustment',
    targetId: data.adjustmentId,
    workspaceId: data.workspaceId,
    meta: { input: data, result },
  })
  return { replayed: false }
}
