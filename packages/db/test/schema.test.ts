import { env } from 'cloudflare:workers'
import { isUuidV7, newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  auditLog,
  createDb,
  type Database,
  invitation,
  member,
  notification,
  organization,
  session,
  user,
} from '../src/index.ts'

// 认证 / 租户 / 平台表的约束（tasks.md 1.1、1.2）：经 Hyperdrive 绑定以 app 账号读写本地 PG。
const open = () => createDb(env.HYPERDRIVE)

/** postgres.js 的错误经 drizzle 包装后放在 cause 中；取出 SQLSTATE 与约束名。 */
async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await promise
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause
    return { code: cause?.code, constraint: cause?.constraint_name }
  }
  throw new Error('expected the statement to fail')
}

async function seed(db: Database) {
  const userId = newId()
  const orgId = newId()
  await db.insert(user).values({ id: userId, name: 'Test', email: `${userId}@example.test` })
  await db.insert(organization).values({
    id: orgId,
    name: 'Personal',
    slug: `u-${orgId.slice(-12)}`,
    isPersonal: true,
  })
  await db.insert(member).values({ id: newId(), organizationId: orgId, userId, role: 'owner' })
  return { userId, orgId }
}

/** 按外键依赖倒序清理（所有外键都是 on delete restrict，必须先删引用方）。 */
async function cleanup(db: Database, userIds: string[], orgIds: string[]) {
  await db.delete(notification).where(inArray(notification.userId, userIds))
  // audit_log 对 app 只追加（迁移 0009），审计行由 migrator 清理
  await createDb(env.HYPERDRIVE_MIGRATOR)
    .delete(auditLog)
    .where(inArray(auditLog.actorUserId, userIds))
  await db.delete(invitation).where(inArray(invitation.organizationId, orgIds))
  await db.delete(session).where(inArray(session.userId, userIds))
  await db.delete(member).where(inArray(member.organizationId, orgIds))
  await db.delete(organization).where(inArray(organization.id, orgIds))
  await db.delete(user).where(inArray(user.id, userIds))
}

describe('认证与租户表（Hyperdrive → 本地 Postgres）', () => {
  it('UUIDv7 主键写入 uuid 列并原样读回，扩展字段可读写', async () => {
    const db = open()
    const { userId, orgId } = await seed(db)
    try {
      await db
        .update(user)
        .set({ locale: 'zh', timezone: 'Asia/Shanghai' })
        .where(eq(user.id, userId))
      const [row] = await db.select().from(user).where(eq(user.id, userId))
      expect(row?.id).toBe(userId)
      expect(isUuidV7(row?.id ?? '')).toBe(true)
      expect(row).toMatchObject({ locale: 'zh', timezone: 'Asia/Shanghai', emailVerified: false })
      const [org] = await db.select().from(organization).where(eq(organization.id, orgId))
      expect(org).toMatchObject({ isPersonal: true, deletedAt: null })
    } finally {
      await cleanup(db, [userId], [orgId])
    }
  })

  it('id 列拒绝非 UUID 的字符串', async () => {
    const db = open()
    const error = await pgError(
      db.insert(user).values({ id: 'not-a-uuid', name: 'x', email: `${newId()}@example.test` }),
    )
    expect(error.code).toBe('22P02') // invalid_text_representation
  })

  it('删除仍被引用的 user 行被数据库拒绝（on delete restrict）', async () => {
    const db = open()
    const { userId, orgId } = await seed(db)
    try {
      const error = await pgError(db.delete(user).where(eq(user.id, userId)))
      expect(error).toEqual({ code: '23503', constraint: 'member_user_id_user_id_fk' })

      // 其他引用 user 的表同样阻止删除：session、audit_log、notification
      await db.delete(member).where(eq(member.userId, userId))
      await db.insert(session).values({
        id: newId(),
        userId,
        token: newId(),
        expiresAt: new Date(Date.now() + 60_000),
        activeOrganizationId: orgId,
      })
      expect(await pgError(db.delete(user).where(eq(user.id, userId)))).toEqual({
        code: '23503',
        constraint: 'session_user_id_user_id_fk',
      })
      await db.delete(session).where(eq(session.userId, userId))
      await db.insert(auditLog).values({ actorUserId: userId, workspaceId: orgId, action: 'test' })
      expect((await pgError(db.delete(user).where(eq(user.id, userId)))).code).toBe('23503')
      await createDb(env.HYPERDRIVE_MIGRATOR)
        .delete(auditLog)
        .where(eq(auditLog.actorUserId, userId))
      await db.insert(notification).values({ userId, type: 'test', title: 't' })
      expect((await pgError(db.delete(user).where(eq(user.id, userId)))).code).toBe('23503')

      expect(await db.select({ id: user.id }).from(user).where(eq(user.id, userId))).toHaveLength(1)
    } finally {
      await cleanup(db, [userId], [orgId])
    }
  })

  it('删除仍被引用的 organization 行被数据库拒绝', async () => {
    const db = open()
    const { userId, orgId } = await seed(db)
    try {
      const error = await pgError(db.delete(organization).where(eq(organization.id, orgId)))
      expect(error).toEqual({
        code: '23503',
        constraint: 'member_organization_id_organization_id_fk',
      })

      await db.delete(member).where(eq(member.organizationId, orgId))
      await db.insert(invitation).values({
        id: newId(),
        organizationId: orgId,
        email: 'invitee@example.test',
        role: 'member',
        inviterId: userId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      expect(await pgError(db.delete(organization).where(eq(organization.id, orgId)))).toEqual({
        code: '23503',
        constraint: 'invitation_organization_id_organization_id_fk',
      })
    } finally {
      await cleanup(db, [userId], [orgId])
    }
  })

  it('同一用户在同一空间只能有一条成员记录', async () => {
    const db = open()
    const { userId, orgId } = await seed(db)
    try {
      const error = await pgError(
        db.insert(member).values({ id: newId(), organizationId: orgId, userId, role: 'member' }),
      )
      expect(error).toEqual({ code: '23505', constraint: 'member_organization_id_user_id_unique' })
    } finally {
      await cleanup(db, [userId], [orgId])
    }
  })

  it('空间 slug 全局唯一', async () => {
    const db = open()
    const a = await seed(db)
    const slug = `u-${a.orgId.slice(-12)}`
    const otherOrg = newId()
    try {
      const error = await pgError(
        db.insert(organization).values({ id: otherOrg, name: 'Other', slug }),
      )
      expect(error).toEqual({ code: '23505', constraint: 'organization_slug_unique' })
    } finally {
      await cleanup(db, [a.userId], [a.orgId, otherOrg])
    }
  })
})
