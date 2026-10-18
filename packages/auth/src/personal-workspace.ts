import type { Database, Organization } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import type { BetterAuthOptions } from 'better-auth'

/**
 * 个人空间（design.md 决策 4、5，specs/workspace-tenancy「注册即创建个人空间」）。
 *
 * - 注册后在 `databaseHooks.user.create.after` 中创建：`is_personal=true`，用户为 owner；
 *   新会话的 `active_organization_id` 默认指向个人空间（`session.create.before`）。
 * - 钩子与用户创建不在同一事务中，钩子失败只记日志、不让注册失败；`withWorkspace`
 *   找不到个人空间时调用 `ensurePersonalWorkspace` 补建。
 * - 幂等：个人空间的 id 取用户 id（同为 UUIDv7），organization 主键与 member 的
 *   `(organization_id, user_id)` 唯一约束保证并发补建不会产生第二个个人空间或重复的成员行。
 * - slug 为 `u-` + 8 位随机 base36，与已有 slug 冲突时换一个重试。
 */

export const PERSONAL_SLUG_PREFIX = 'u-'
const SLUG_RANDOM_LENGTH = 8
const SLUG_ATTEMPTS = 5
/** 个人空间的默认名称（用户可修改）；P6 接入 i18n 前先用英文 */
export const PERSONAL_WORKSPACE_NAME = 'Personal'

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `u-` + 8 位随机 base36；用拒绝采样避免取模偏差 */
export function personalSlug(): string {
  let out = ''
  while (out.length < SLUG_RANDOM_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SLUG_RANDOM_LENGTH))) {
      // 252 = 36 * 7：丢弃 252–255，其余字节均匀映射到 36 个字符
      if (byte < 252 && out.length < SLUG_RANDOM_LENGTH) out += BASE36[byte % 36]
    }
  }
  return PERSONAL_SLUG_PREFIX + out
}

/** 用户的个人空间（含已软删的）；不存在时返回 `undefined` */
export async function findPersonalWorkspace(
  db: Database,
  userId: string,
): Promise<Organization | undefined> {
  return db.query.organization.findFirst({
    where: (o, { and, eq }) => and(eq(o.id, userId), eq(o.isPersonal, true)),
  })
}

/**
 * 幂等补建个人空间；与删号使用相同的 owner 锁，已删除空间从不重新添加成员。
 */
export async function ensurePersonalWorkspace(
  db: Database,
  user: { readonly id: string },
): Promise<Organization> {
  return db.$client.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${user.id}`}, 0))`
    const [available] = await sql`select id from "user" where id=${user.id}
      and not (coalesce(banned,false) and (ban_expires is null or ban_expires>now()))`
    if (!available) throw new AppError('USER_BANNED', 'Account unavailable', { status: 403 })
    const read = async () => {
      const [workspace] = await sql<Organization[]>`select id,name,slug,logo,metadata,
        created_at as "createdAt",updated_at as "updatedAt",is_personal as "isPersonal",deleted_at as "deletedAt"
        from organization where id=${user.id} and is_personal=true`
      return workspace
    }
    let workspace = await read()
    for (let attempt = 0; !workspace && attempt < SLUG_ATTEMPTS; attempt++) {
      await sql`insert into organization (id,name,slug,is_personal)
        values (${user.id},${PERSONAL_WORKSPACE_NAME},${personalSlug()},true) on conflict do nothing`
      workspace = await read()
    }
    if (!workspace) throw new Error('Unable to create personal workspace')
    if (!workspace.deletedAt) {
      await sql`insert into member (id,organization_id,user_id,role)
        values (${newId()},${workspace.id},${user.id},'owner') on conflict do nothing`
    }
    return workspace
  })
}

/**
 * 接到 `createAuth` 的 `databaseHooks`：注册后创建个人空间；新会话没有活跃空间时指向个人空间。
 *
 * Better Auth 把 `create.after` 推迟到整个注册流程（`runWithTransaction`）结束后执行，
 * 注册时自动登录的会话已先于个人空间创建，因此钩子里补设该用户尚无活跃空间的会话。
 * 这只改数据库行，Cookie 缓存与 KV 中的副本仍为空，直到会话刷新；活跃空间为空时
 * `/app` 同样回退到个人空间，结果一致。之后登录创建的会话由 `session.create.before` 直接带上。
 */
export function personalWorkspaceHooks(db: Database) {
  return {
    user: {
      create: {
        after: async (user) => {
          try {
            const workspace = await ensurePersonalWorkspace(db, user)
            // 本包不直接依赖 drizzle-orm（见 test/helpers.ts），条件更新用参数化的原始 SQL
            await db.$client`
              update session set active_organization_id = ${workspace.id}
              where user_id = ${user.id} and active_organization_id is null`
          } catch (error) {
            // 不让注册失败：withWorkspace 会补建（design.md 决策 4）
            console.error(
              JSON.stringify({
                event: 'personal_workspace.create_failed',
                userId: user.id,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (session.activeOrganizationId) return
          const personal = await findPersonalWorkspace(db, session.userId)
          if (!personal || personal.deletedAt) return
          return { data: { ...session, activeOrganizationId: personal.id } }
        },
      },
    },
  } satisfies BetterAuthOptions['databaseHooks']
}
