import type { Database } from '@product-res/db'
import { auditLog, user } from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

type BootstrapTrigger = 'user.create' | 'user.update' | 'email.verify' | 'session.create'

export interface AdminBootstrapOptions {
  /**
   * 不要求邮箱已验证（BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED=true）。用于未接邮件服务的部署：
   * 谁先以名单邮箱注册谁就成为管理员，须配合只放行运维邮箱的 SIGNUP_ALLOWED_EMAILS，提升后关闭。
   */
  readonly allowUnverified?: boolean
}

/** 认证事件只提供用户 id；授权条件必须以已提交的数据库状态为准。 */
export function adminBootstrap(
  db: Database,
  configuredEmails: string | undefined,
  options: AdminBootstrapOptions = {},
) {
  const emails = [
    ...new Set(
      (configuredEmails ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]

  return async (userId: string, trigger: BootstrapTrigger) => {
    if (emails.length === 0) return
    // 管理员认证动作传入 Drizzle 事务；transaction 在其上创建 savepoint，沿用外层提交边界。
    await db.transaction(async (tx) => {
      const eligible = and(
        eq(user.id, userId),
        options.allowUnverified ? undefined : eq(user.emailVerified, true),
        sql`${user.banned} is not true`,
        inArray(sql<string>`lower(trim(${user.email}))`, emails),
      )
      // 锁定候选行以取得准确的角色前值；并发触发在锁释放后重新检查资格。
      const [candidate] = await tx
        .select({ role: user.role })
        .from(user)
        .where(eligible)
        .for('update')
      if (!candidate) return
      // 与后台守卫一致：逗号多角色中已有 admin 时保留全部角色及更新时间。
      if ((candidate.role ?? '').split(',').some((role) => role.trim() === 'admin')) return
      const [promoted] = await tx
        .update(user)
        .set({ role: 'admin', updatedAt: new Date() })
        .where(
          and(
            eligible,
            candidate.role === null ? isNull(user.role) : eq(user.role, candidate.role),
          ),
        )
        .returning({ id: user.id })
      if (!promoted) return
      // 系统审计与提升同事务：审计失败时不能留下未记录的管理员角色。
      await tx.insert(auditLog).values({
        id: newId(),
        action: 'admin.user.bootstrap',
        targetType: 'user',
        targetId: userId,
        meta: { trigger, before: { role: candidate.role }, after: { role: 'admin' } },
      })
    })
  }
}
