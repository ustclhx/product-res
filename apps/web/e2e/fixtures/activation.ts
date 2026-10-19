import { createDb, type Database } from '@product-res/db'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { newId } from '@product-res/shared'
import templateConfig from '../../../../template.config.ts'

/**
 * 内测准入（add-beta-access-gate）的 e2e 夹具：以 0 积分的管理员批次开通空间，不改变余额与账本。
 * 生产发放必须经后台 adjustAdminCredits → packages/credits；这里只为隔离库造数。
 */
const required = () => templateConfig.credits.requireGrantForAccess

/** 直接写库的团队空间同样需要管理员批次；清理空间前先调用 removeWorkspaceActivation（外键 restrict）。 */
export async function activateWorkspace(sql: Database['$client'], workspaceId: string) {
  if (!required()) return
  await sql`insert into credit_grant (id, workspace_id, source, source_ref, amount, remaining)
    values (${newId()}, ${workspaceId}, 'admin', ${`e2e-activation:${newId()}`}, 0, 0)`
}

export async function removeWorkspaceActivation(sql: Database['$client'], workspaceId: string) {
  await sql`delete from credit_grant where workspace_id = ${workspaceId}
    and source = 'admin' and source_ref like 'e2e-activation:%'`
}

/** 开通账号的个人空间；与 smoke-setup 相同只连本地隔离库（worktree 库或 CI 的 product_res_ci_e2e）。 */
export async function activateAccount(email: string) {
  if (!required()) return
  const connectionString = readLocalEnv('MIGRATION_DATABASE_URL')
  if (!connectionString) throw new Error('Activation requires an isolated local database')
  const url = new URL(connectionString)
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !(url.pathname.startsWith('/product_res_wt_') || url.pathname === '/product_res_ci_e2e')
  )
    throw new Error('Activation requires a worktree database or product_res_ci_e2e on localhost')
  const db = createDb({ connectionString })
  try {
    const inserted = await db.$client`insert into credit_grant
      (id, workspace_id, source, source_ref, amount, remaining)
      select ${newId()}, m.organization_id, 'admin', ${`e2e-activation:${newId()}`}, 0, 0
      from member m join "user" u on u.id = m.user_id
      join organization o on o.id = m.organization_id
      where u.email = ${email} and o.is_personal and m.role = 'owner'
      returning id`
    if (inserted.length !== 1) throw new Error('Missing personal workspace to activate')
  } finally {
    await db.$client.end()
  }
}
