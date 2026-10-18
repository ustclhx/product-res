import type { Page } from '@playwright/test'
import { type EntitlementSubscription, selectEntitlements } from '@product-res/entitlements'
import templateConfig from '../../../../template.config.ts'
import { guidancePrefix } from './accounts.ts'
import { FAULT_MODELS } from './fault-definitions.ts'
import { adminIdentity, login, query, sessionUser, sqlLiteral } from './support.ts'

export type FaultWorkspace = {
  workspaceId: string
  userId: string
  slug: string
  version: string
}

export async function prepareFaultReadiness(page: Page): Promise<FaultWorkspace> {
  const missing = ['STAGING_URL', 'NEON_READONLY_URL', 'STAGING_FAULT_EXPECTED_SHA'].filter(
    (name) => !process.env[name],
  )
  if (missing.length)
    throw new Error(`${guidancePrefix}故障套件：缺少环境变量：${missing.join(', ')}`)
  const version = process.env.STAGING_FAULT_EXPECTED_SHA ?? ''
  if (!/^[0-9a-f]{40}$/i.test(version))
    throw new Error(`${guidancePrefix}故障套件：STAGING_FAULT_EXPECTED_SHA 必须为完整提交 SHA`)
  const health = await page.request.get('/api/health', { headers: { 'cache-control': 'no-cache' } })
  const body = await health.json().catch(() => null)
  if (
    health.status() !== 200 ||
    !health.headers()['cache-control']?.includes('no-store') ||
    body?.db?.status !== 'up' ||
    body?.version !== version
  )
    throw new Error(
      `${guidancePrefix}故障套件：health 必须为 no-store、数据库 up 且版本与预期 SHA 完全一致`,
    )
  await login(page, 'admin')
  const admin = adminIdentity(await sessionUser(page))
  await page.goto('/app')
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const rows = await query<{ id: string }>(`select o.id from organization o join member m
    on m.organization_id=o.id where o.slug=${sqlLiteral(slug)}
    and m.user_id=${sqlLiteral(admin.id)} and o.deleted_at is null`)
  if (rows.length !== 1 || !rows[0])
    throw new Error(`${guidancePrefix}故障套件：管理员自己的验收空间不存在`)
  const workspaceId = rows[0].id
  const id = sqlLiteral(workspaceId)
  const [snapshot] = await query<{
    subscriptions: EntitlementSubscription[]
    free: Parameters<typeof selectEntitlements>[1] | null
    balance: number
    debt: number
    activeTasks: number
    storageBytes: number
    now: string
  }>(`select
    coalesce((select json_agg(json_build_object('status',s.status,
      'pastDueSince',s.past_due_since,'currentPeriodEnd',s.current_period_end,
      'plan',json_build_object('key',p.key,'sort',p.sort,'features',p.features)))
      from subscription s join plan p on p.id=s.plan_id where s.workspace_id=${id}), '[]'::json) as subscriptions,
    (select json_build_object('key',key,'sort',sort,'features',features) from plan where key='free') as free,
    (select coalesce(sum(remaining),0)::float8 from credit_grant where workspace_id=${id}
      and status='active' and (expires_at is null or expires_at>now())) as balance,
    (select coalesce(sum(amount),0)::float8 from credit_debt where workspace_id=${id}) as debt,
    (select count(*)::int from ai_task where workspace_id=${id} and status in ('queued','running')) as "activeTasks",
    (select coalesce(sum(size),0)::float8 from file where workspace_id=${id}
      and status='ready' and deleted_at is null) as "storageBytes", now() as now`)
  if (!snapshot) throw new Error(`${guidancePrefix}故障套件：无法读取空间准备条件`)
  const { features } = selectEntitlements(snapshot.subscriptions, snapshot.free ?? undefined, {
    now: new Date(snapshot.now),
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
  })
  const missingModels = !features.models.includes('*')
    ? FAULT_MODELS.filter((model) => !features.models.includes(model.key)).length
    : 0
  const capacity = features.storageGb * 1024 ** 3
  if (
    missingModels ||
    snapshot.balance < 30 ||
    snapshot.debt !== 0 ||
    snapshot.activeTasks >= features.maxConcurrentTasks ||
    capacity - snapshot.storageBytes < 10 * 1024 ** 2
  )
    throw new Error(
      `${guidancePrefix}故障套件：请管理员核对 user=${admin.id} workspace=${workspaceId}：缺模型权限=${missingModels}，余额=${snapshot.balance}（至少30），欠费=${snapshot.debt}，在途=${snapshot.activeTasks}，并发上限=${features.maxConcurrentTasks}，剩余存储字节=${capacity - snapshot.storageBytes}（至少10485760）；准备完成后用同一 run ID 重跑`,
    )
  return { workspaceId, userId: admin.id, slug, version }
}
