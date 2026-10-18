import type { Database } from '@product-res/db'
import type { DatabaseAccess } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { WORKSPACE_CLEANUP_CRON } from './workspace-cleanup.ts'

/**
 * 与每日空间清理共用 UTC 03:00 触发器汇总前一日（Cloudflare 免费版每账号最多 5 个 Cron 触发器，
 * 不再单独占用一个）；两项任务互不影响，见 src/index.ts。
 */
export const METRICS_DAILY_CRON = WORKSPACE_CLEANUP_CRON

/** 同一快照内聚合并覆盖写；重复运行不会累计。订阅为运行时观察到的日末有效状态。 */
export async function summarizeDailyMetrics(db: Database, day: string) {
  const start = new Date(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== day)
    throw new Error('Invalid metrics day')
  const end = new Date(start.getTime() + 86_400_000)
  return db.$client.begin('isolation level repeatable read', async (sql) => {
    // 跨空间汇总仅在 jobs 执行；所有日期均为 UTC，日末存量与当日增量分开。
    const [users] = await sql<{ registrations: number; total: number }[]>`
      select count(*) filter (where created_at >= ${start.toISOString()})::int as registrations,
        count(*)::int as total from "user" where created_at < ${end.toISOString()}`
    const [spaces] = await sql<{ total: number }[]>`
      select count(*)::int as total from organization where created_at < ${end.toISOString()}
        and (deleted_at is null or deleted_at >= ${end.toISOString()})`
    const paid = await sql<{ currency: string; mrr: number; workspace_id: string }[]>`
      select upper(p.currency) as currency, s.workspace_id,
        sum(p.amount::numeric / case when p.interval='year' then 12 else 1 end)::float8 as mrr
      from subscription s join plan_price p on p.id=s.plan_price_id
      join organization o on o.id=s.workspace_id
      where s.created_at < ${end.toISOString()} and p.amount>0 and p.interval in ('month','year')
        and s.status in ('active','canceled','expired')
        and s.current_period_start < ${end.toISOString()} and s.current_period_end >= ${end.toISOString()}
        and (o.deleted_at is null or o.deleted_at >= ${end.toISOString()})
      group by upper(p.currency), s.workspace_id`
    const mrr: Record<string, number> = {}
    for (const row of paid) mrr[row.currency] = (mrr[row.currency] ?? 0) + row.mrr
    const [credits] = await sql<{ consumed: number }[]>`
      select coalesce(-sum(delta),0)::int as consumed from credit_ledger
      where type='consume' and created_at >= ${start.toISOString()} and created_at < ${end.toISOString()}`
    // hold 的 updated_at 是结算时间；无消息的媒体 hold 归入 unknown，P4 可扩展关联。
    const overage = await sql<{ model: string; amount: number }[]>`
      select coalesce(m.model_key,'unknown') as model, sum(h.overage_absorbed)::int as amount
      from credit_hold h left join ai_message m on h.ref_type='ai_message' and m.id=h.ref_id
      where h.status='captured' and h.updated_at >= ${start.toISOString()}
        and h.updated_at < ${end.toISOString()} and h.overage_absorbed>0
      group by coalesce(m.model_key,'unknown')`
    const byModel = Object.fromEntries(overage.map((row) => [row.model, row.amount]))
    const absorbed = overage.reduce((total, row) => total + row.amount, 0)
    const [text] = await sql<{ completed: number; failed: number; aborted: number }[]>`
      select count(*) filter (where status='completed')::int as completed,
        count(*) filter (where status='failed')::int as failed,
        count(*) filter (where status='aborted')::int as aborted
      from ai_message where role='assistant' and status in ('completed','failed','aborted')
        and updated_at >= ${start.toISOString()} and updated_at < ${end.toISOString()}`
    const [result] = await sql`
      insert into metrics_daily (day,registrations,total_users,total_workspaces,paid_workspaces,
        mrr_by_currency,credits_consumed,overage_absorbed,overage_by_model,
        text_completed,text_failed,text_aborted,data_through,computed_at)
      values (${day},${users?.registrations ?? 0},${users?.total ?? 0},${spaces?.total ?? 0},
        ${new Set(paid.map((row) => row.workspace_id)).size},${JSON.stringify(mrr)}::jsonb,${credits?.consumed ?? 0},
        ${absorbed},${JSON.stringify(byModel)}::jsonb,${text?.completed ?? 0},${text?.failed ?? 0},${text?.aborted ?? 0},
        ${end.toISOString()},now())
      on conflict (day) do update set registrations=excluded.registrations,total_users=excluded.total_users,
        total_workspaces=excluded.total_workspaces,paid_workspaces=excluded.paid_workspaces,
        mrr_by_currency=excluded.mrr_by_currency,credits_consumed=excluded.credits_consumed,
        overage_absorbed=excluded.overage_absorbed,overage_by_model=excluded.overage_by_model,
        text_completed=excluded.text_completed,text_failed=excluded.text_failed,text_aborted=excluded.text_aborted,
        data_through=excluded.data_through,computed_at=excluded.computed_at returning *`
    return result
  })
}

export async function runMetricsDaily(context: { db: DatabaseAccess }, scheduledTime: number) {
  const day = new Date(scheduledTime - 86_400_000).toISOString().slice(0, 10)
  await summarizeDailyMetrics(context.db.business(), day)
  log.info('cron.metrics-daily', { day })
}
