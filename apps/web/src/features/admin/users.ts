import { account, type Database, member, organization, user } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { desc, eq, ilike, or, sql } from 'drizzle-orm'
import { ADMIN_PAGE_SIZE, adminListSearch } from './list.ts'

export async function listAdminUsers(
  db: Database,
  input: { offset?: number; q?: string | undefined },
) {
  const { offset, q } = adminListSearch(['q'])(input)
  const where = q
    ? or(
        ilike(user.email, `%${q}%`),
        ilike(user.name, `%${q}%`),
        ilike(sql`${user.id}::text`, `%${q}%`),
      )
    : undefined
  const rows = await db
    .select()
    .from(user)
    .where(where)
    .orderBy(desc(user.createdAt), desc(user.id))
    .offset(offset)
    .limit(ADMIN_PAGE_SIZE + 1)
  return { rows: rows.slice(0, ADMIN_PAGE_SIZE), hasMore: rows.length > ADMIN_PAGE_SIZE }
}

export async function adminUserDetail(db: Database, id: string) {
  const [target] = await db.select().from(user).where(eq(user.id, id))
  if (!target) throw new AppError('NOT_FOUND', 'User not found', { status: 404 })
  const workspaces = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
      deletedAt: organization.deletedAt,
    })
    // biome-ignore lint/plugin: 平台管理员按用户查询其所属的全部空间。
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, id))
  const methods = await db
    .select({ provider: account.providerId })
    .from(account)
    .where(eq(account.userId, id))
  return { user: target, workspaces, methods: [...new Set(methods.map((m) => m.provider))] }
}
