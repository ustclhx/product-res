// biome-ignore-all lint/plugin: 回看提醒是系统定时任务，需跨空间找出到期的跟卖决定；写入时再经 scoped 限定到该空间。
import {
  type Database,
  decision,
  followOutcome,
  leadEvent,
  member,
  notification,
  notificationLink,
  organization,
  scoped,
  transferringWorkspaceIds,
} from '@product-res/db'
import type { ScheduleDefinition, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm'

/**
 * 30 天回看提醒（openspec/changes/add-costing-decisions design D5、specs/selection-archive）。
 * 跟卖决定的计划上架日 + 30 天已到、尚未录入回看的，给决定人（不在空间时给所有者 / 管理员）发站内通知。
 * 每条决定只提醒一次：发送时在 lead_event 写一条 note（payload.type = review-reminder），
 * 与通知同一事务提交；档案库据到期日显示“待回看”，据该标记显示已提醒。
 */

export const REVIEW_DAYS = 30
/** 与 apps/web/src/features/costing/archive.server.ts 的 REVIEW_REMINDER_EVENT 一致 */
export const REVIEW_REMINDER_EVENT = 'review-reminder'
export const SELECTION_REVIEW_SCHEDULE: ScheduleDefinition = {
  id: 'selection-review-v1',
  cron: '0 9 * * *',
  timeZone: 'Asia/Singapore',
  missedRun: 'once',
}
/** 单次最多处理的决定数；更多的留到下一次（missedRun once 会补跑） */
const BATCH = 500

const SGT_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** 计划上架日不晚于此日期的决定已到回看期（新加坡时间的今天 − 30 天） */
export function reviewCutoff(now: Date): string {
  return new Date(now.getTime() + SGT_OFFSET_MS - REVIEW_DAYS * DAY_MS).toISOString().slice(0, 10)
}

/** 某条决定已写过回看提醒；leadId / decisionId 可以是列（子查询关联）或具体值 */
const reminded = (leadId: SQL | string, decisionId: SQL | string) =>
  and(
    sql`${leadEvent.leadId} = ${leadId}`,
    eq(leadEvent.kind, 'note'),
    sql`${leadEvent.payload}->>'type' = ${REVIEW_REMINDER_EVENT}`,
    sql`${leadEvent.payload}->>'decisionId' = ${decisionId}`,
  ) as SQL

export async function runSelectionReview(db: Database, now: Date) {
  const cutoff = reviewCutoff(now)
  const transferring = [...(await transferringWorkspaceIds(db))]
  const due = await db
    .select({
      id: decision.id,
      workspaceId: decision.workspaceId,
      leadId: decision.leadId,
      decidedBy: decision.decidedBy,
      plannedListingOn: decision.plannedListingOn,
      clusterName: sql<string | null>`${decision.snapshot}->'cluster'->>'name'`,
      slug: organization.slug,
    })
    .from(decision)
    .innerJoin(
      organization,
      and(eq(organization.id, decision.workspaceId), isNull(organization.deletedAt)),
    )
    .where(
      and(
        transferring.length > 0 ? notInArray(decision.workspaceId, transferring) : undefined,
        eq(decision.kind, 'follow'),
        isNotNull(decision.plannedListingOn),
        lte(decision.plannedListingOn, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(followOutcome)
            .where(
              and(
                eq(followOutcome.decisionId, decision.id),
                eq(followOutcome.reviewDays, REVIEW_DAYS),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(leadEvent)
            .where(reminded(sql`${decision.leadId}`, sql`${decision.id}::text`)),
        ),
      ),
    )
    .orderBy(asc(decision.plannedListingOn))
    .limit(BATCH)

  let notified = 0
  for (const item of due) {
    try {
      if (await remind(db, item)) notified += 1
    } catch (error) {
      // 单条失败（如决定人与管理员都已离开空间）不影响其他空间
      log.error('selection_review.remind_failed', { error, decisionId: item.id })
    }
  }
  if (due.length > 0) log.info('selection_review.done', { due: due.length, notified })
  return { due: due.length, notified }
}

async function remind(
  db: Database,
  item: {
    id: string
    workspaceId: string
    leadId: string
    decidedBy: string | null
    plannedListingOn: string | null
    clusterName: string | null
    slug: string
  },
) {
  return scoped(db, item.workspaceId).transaction(async (tx) => {
    // 锁住决定行，重复运行或并发执行时只有一次能写入提醒
    await tx.select(decision, { where: eq(decision.id, item.id) }).for('update')
    const [already] = await tx.select(leadEvent, { where: reminded(item.leadId, item.id) }).limit(1)
    if (already) return false
    const members = await tx.select(member, {
      fields: { userId: member.userId, role: member.role },
    })
    const decider = members.find((m) => m.userId === item.decidedBy)
    const recipients = decider
      ? [decider.userId]
      : members.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.userId)
    if (recipients.length === 0) throw new Error('no recipient for review reminder')
    const dueOn = item.plannedListingOn
      ? new Date(Date.parse(`${item.plannedListingOn}T00:00:00Z`) + REVIEW_DAYS * DAY_MS)
          .toISOString()
          .slice(0, 10)
      : null
    await tx.insert(leadEvent, {
      leadId: item.leadId,
      kind: 'note',
      payload: { type: REVIEW_REMINDER_EVENT, decisionId: item.id, reviewDays: REVIEW_DAYS, dueOn },
    })
    const link = notificationLink(
      `/app/${encodeURIComponent(item.slug)}/archive?kind=follow`,
    ) as string
    await tx.insert(
      notification,
      recipients.map((userId) => ({
        userId,
        type: 'selection.review_due',
        title: `跟卖回看：${item.clusterName ?? '已跟卖商品'}`,
        body: `计划上架日 ${item.plannedListingOn} 已过 ${REVIEW_DAYS} 天，请在选品档案库录入实际销量与售价。`,
        link,
      })),
    )
    return true
  })
}

/** Node 调度注册：在 engine.register 内调用 */
export function registerSelectionReview(scheduler: Scheduler, db: Database) {
  scheduler.register(SELECTION_REVIEW_SCHEDULE, async ({ scheduledAt }) => {
    await runSelectionReview(db, scheduledAt)
  })
}
