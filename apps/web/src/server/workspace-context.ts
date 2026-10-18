import { ensurePersonalWorkspace } from '@product-res/auth'
import { type Database, type Member, member, type Organization, scoped } from '@product-res/db'
import { eq } from 'drizzle-orm'

/**
 * 当前空间的解析（docs/04-auth-and-tenancy.md §3「当前空间的解析」，specs/workspace-tenancy）：
 * URL 中的 `$slug` → 会话的 `active_organization_id` → 用户的个人空间（后两者只用于 `/app` 的重定向）。
 *
 * 成员身份每次都查库（specs/workspace-tenancy「每次请求校验成员身份」）：会话里的活跃空间
 * 只是候选，不据此放行；被移出的成员即使会话缓存仍有效也拿不到空间。
 * 不存在、已软删、不是成员三种情况一律视为不存在（调用方返回 404），不泄露空间是否存在。
 */

export interface ResolvedWorkspace {
  readonly workspace: Organization
  readonly member: Member
}

/** 用户在该空间的成员行；空间已软删时视为没有 */
async function membership(
  db: Database,
  workspace: Organization | undefined,
  userId: string,
): Promise<ResolvedWorkspace | null> {
  if (!workspace || workspace.deletedAt) return null
  const [row] = await scoped(db, workspace.id)
    .select(member, { where: eq(member.userId, userId) })
    .limit(1)
  return row ? { workspace, member: row } : null
}

/** 按 URL 中的 slug 解析；不存在或不是成员时返回 `null` */
export async function resolveWorkspaceBySlug(
  db: Database,
  userId: string,
  slug: string,
): Promise<ResolvedWorkspace | null> {
  const workspace = await db.query.organization.findFirst({
    where: (o, { eq }) => eq(o.slug, slug),
  })
  return membership(db, workspace, userId)
}

/**
 * `/app` 的重定向目标：会话中的活跃空间（仍是成员时）→ 个人空间。
 * 个人空间缺失时补建（注册钩子失败的兜底，design.md 决策 4）；补建幂等，并发请求不会建出两个。
 * 个人空间已软删（账号已删除）时返回 `null`。
 */
export async function resolveDefaultWorkspace(
  db: Database,
  user: { readonly id: string },
  activeOrganizationId: string | null | undefined,
): Promise<ResolvedWorkspace | null> {
  if (activeOrganizationId) {
    const active = await db.query.organization.findFirst({
      where: (o, { eq }) => eq(o.id, activeOrganizationId),
    })
    const resolved = await membership(db, active, user.id)
    if (resolved) return resolved
  }
  return membership(db, await ensurePersonalWorkspace(db, user), user.id)
}
