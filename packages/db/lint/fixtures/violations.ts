// 测试夹具：故意绕过 scoped() 的 feature 代码（no-unscoped-workspace-query.test.ts 使用）。
// 测试会把本文件复制到临时目录的 apps/web/src/features/ 下再运行 Biome；
// 本目录在根 biome.json 的 files.includes 中排除（原位置不在插件范围内，豁免注释会被报为无效）。
// 每个期望被拦下的位置用行尾注释 `expect-lint` 标记。
import { and, eq } from 'drizzle-orm'
import {
  auditLog,
  type Database,
  invitation,
  member,
  notification,
  setting,
} from '../../src/index.ts'
import * as schema from '../../src/schema/index.ts'

export async function listMembers(db: Database, workspaceId: string) {
  // 典型错误：手写空间过滤（ai_task 等业务表同理）
  return db.select().from(member).where(eq(member.organizationId, workspaceId)) // expect-lint
}

export async function forgottenFilter(db: Database, id: string) {
  return db.select({ id: invitation.id }).from(invitation).where(eq(invitation.id, id)) // expect-lint
}

export async function writes(db: Database, workspaceId: string, userId: string) {
  await db.insert(auditLog).values({ workspaceId, action: 'x' }) // expect-lint
  await db.update(schema.notification).set({ readAt: new Date() }) // expect-lint
  await db.delete(notification).where(eq(notification.userId, userId)) // expect-lint
  await db.transaction(async (tx) => {
    await tx.delete(member).where(and(eq(member.userId, userId))) // expect-lint
  })
}

export async function relational(db: Database) {
  return db.query.member.findMany() // expect-lint
}

export async function allowed(db: Database) {
  // 不带空间列的表不受限制
  await db.select().from(setting)
  // 显式豁免
  // biome-ignore lint/plugin: 系统任务跨空间统计
  return db.select().from(member)
}
