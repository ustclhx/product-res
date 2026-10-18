import { auditLog, type Database, type JsonValue, user } from '@product-res/db'
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ADMIN_PAGE_SIZE } from './list.ts'

export const auditSearchSchema = z
  .object({
    offset: z.number().int().min(0).max(100_000),
    actor: z.string().max(200).optional(),
    workspaceId: z.uuid().optional(),
    action: z.string().max(200).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Start date must precede end date',
  })
export type AuditSearch = z.infer<typeof auditSearchSchema>

/** 操作人可用 ID / 邮箱查询；模拟期间也匹配实际管理员 ID。 */
export async function listAuditLogs(db: Database, input: AuditSearch) {
  const data = auditSearchSchema.parse(input)
  const where = and(
    data.actor
      ? or(
          eq(sql`${auditLog.actorUserId}::text`, data.actor),
          eq(user.email, data.actor),
          eq(sql`${auditLog.meta}->>'impersonatedBy'`, data.actor),
        )
      : undefined,
    data.workspaceId ? eq(auditLog.workspaceId, data.workspaceId) : undefined,
    data.action ? eq(auditLog.action, data.action) : undefined,
    data.from ? gte(auditLog.createdAt, new Date(`${data.from}T00:00:00Z`)) : undefined,
    data.to
      ? lt(auditLog.createdAt, new Date(Date.parse(`${data.to}T00:00:00Z`) + 86_400_000))
      : undefined,
  )
  const rows = await db
    .select({ log: auditLog, actorEmail: user.email })
    // biome-ignore lint/plugin: 已通过实时管理员守卫，审计查询允许跨空间筛选。
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorUserId))
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .offset(data.offset)
    .limit(ADMIN_PAGE_SIZE + 1)
  return {
    rows: rows
      .slice(0, ADMIN_PAGE_SIZE)
      .map((row) => ({ ...row, log: { ...row.log, meta: row.log.meta as JsonValue } })),
    hasMore: rows.length > ADMIN_PAGE_SIZE,
  }
}
