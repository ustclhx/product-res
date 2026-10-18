// 测试夹具：通过 scoped() 访问空间表的正确写法，不应被 no-unscoped-workspace-query 拦下。
import { eq } from 'drizzle-orm'
import {
  auditLog,
  type Database,
  invitation,
  member,
  notification,
  scoped,
} from '../../src/index.ts'

export async function handler(db: Database, workspaceId: string, id: string, userId: string) {
  const s = scoped(db, workspaceId)
  const members = await s.select(member).orderBy(member.id)
  const invite = await s.findById(invitation, id)
  await s.insert(auditLog, { action: 'invite.view', targetId: invite.id })
  await s.update(notification, { readAt: new Date() }, eq(notification.userId, userId))
  await s.delete(notification, eq(notification.userId, userId))
  await s.deleteById(invitation, id)
  await s.transaction(async (tx) => {
    await tx.delete(member, eq(member.userId, userId))
  })
  return members
}
