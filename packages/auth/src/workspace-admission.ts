import { newId } from '@product-res/shared'
import { z } from 'zod'

/**
 * 团队空间准入与软删的共用实现：Better Auth 的 organization 钩子、删除流程与跨空间数据流转
 * （openspec/changes/add-workspace-data-transfer D1、D8）都调用这里，规则只有一份。
 *
 * 本文件不依赖 better-auth，经 `@product-res/auth/workspace-admission` 单独导出，
 * 供 packages/follow 的流转服务在 Drizzle 事务中复用；SQL 经调用方提供的标签函数执行，
 * postgres.js 的 `sql` 与 Drizzle 的 `tx.execute(sql\`…\`)` 都可适配。
 */
export type AdmissionSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<readonly Record<string, unknown>[]>

/** 拒绝时由调用方决定错误类型（APIError / AppError） */
export type AdmissionDeny = (code: string, message: string, status: 400 | 403) => never

const slug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const reserved = new Set([
  'admin',
  'api',
  'app',
  'account',
  'login',
  'logout',
  'signup',
  'settings',
  'invite',
  'new',
])

/** 团队 slug：小写字母数字与连字符，非保留字，且不能使用个人空间的 `u-` 前缀 */
export function isValidTeamSlug(value: unknown): value is string {
  const parsed = slug.safeParse(value)
  return parsed.success && !reserved.has(parsed.data) && !parsed.data.startsWith('u-')
}

/**
 * 新建团队空间的准入：团队 owner 数量上限与 slug 唯一。调用方须已在同一事务中持有
 * `owner:<userId>` 锁（锁顺序 owner: → slug: → ws:，见 docs/04-auth-and-tenancy.md）。
 */
export async function admitTeamWorkspace(
  sql: AdmissionSql,
  input: { readonly userId: string; readonly slug: string; readonly maxWorkspacesPerUser: number },
  deny: AdmissionDeny,
): Promise<void> {
  const [count] = await sql`select count(*)::int as total from member m
    join organization o on o.id=m.organization_id
    where m.user_id=${input.userId} and m.role='owner' and not o.is_personal and o.deleted_at is null`
  if (Number(count?.total ?? 0) >= input.maxWorkspacesPerUser)
    deny('WORKSPACE_LIMIT', 'Workspace limit reached', 403)
  // slug 准入同样串行化；数据库唯一约束仍是最终保证
  await sql`select pg_advisory_xact_lock(hashtextextended(${`slug:${input.slug}`}, 0))`
  if ((await sql`select id from organization where slug=${input.slug}`).length)
    deny('SLUG_TAKEN', 'Slug already in use', 400)
}

/**
 * 软删空间：作废邀请与邀请链接、禁用空间 API Key、清空指向该空间的活跃会话、移除成员并写审计。
 * 调用方须持有 owner 锁与 `ws:` 锁。返回需要在事务提交后失效的会话 token。
 */
export async function softDeleteWorkspace(
  sql: AdmissionSql,
  id: string,
  actorId: string,
  ip: string | null,
): Promise<string[]> {
  const owners = await sql`select user_id from member where organization_id=${id} and role='owner'`
  await sql`update organization set deleted_at=now(),updated_at=now() where id=${id}`
  await sql`update invitation set status='canceled',updated_at=now() where organization_id=${id} and status='pending'`
  // 邀请链接与邮件邀请一致：软删即作废，恢复空间后旧链接仍作废（add-team-invite-links）
  await sql`update workspace_invite_link set revoked_at=now(),revoked_by=${actorId},updated_at=now() where workspace_id=${id} and revoked_at is null`
  // metadata is text in the installed API key schema. Parse without a SQL JSON cast so malformed
  // unrelated metadata cannot prevent deleting a workspace.
  const keys = await sql`select id,metadata from apikey where enabled=true`
  for (const key of keys) {
    let metadata: { workspace_id?: string; workspaceId?: string } | null
    try {
      metadata = key.metadata ? JSON.parse(String(key.metadata)) : null
    } catch {
      continue
    }
    if (metadata?.workspace_id === id || metadata?.workspaceId === id)
      await sql`update apikey set enabled=false,updated_at=now() where id=${key.id}`
  }
  const sessions =
    await sql`update session set active_organization_id=null,updated_at=now() where active_organization_id=${id} returning token`
  await sql`delete from member where organization_id=${id}`
  await sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,ip,meta)
    values (${newId()},${actorId},${id},'workspace.deleted','organization',${id},${ip},${JSON.stringify({ originalOwnerUserIds: owners.map((owner) => owner.user_id) })}::jsonb)`
  return sessions.map((session) => String(session.token))
}
