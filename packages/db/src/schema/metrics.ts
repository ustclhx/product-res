import { date, integer, jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core'

/** UTC 日级指标；金额单位为 cents，按币种保留，避免隐式汇率换算。 */
export const metricsDaily = pgTable('metrics_daily', {
  day: date('day').primaryKey(),
  registrations: integer('registrations').notNull(),
  totalUsers: integer('total_users').notNull(),
  totalWorkspaces: integer('total_workspaces').notNull(),
  paidWorkspaces: integer('paid_workspaces').notNull(),
  mrrByCurrency: jsonb('mrr_by_currency').$type<Record<string, number>>().notNull(),
  creditsConsumed: integer('credits_consumed').notNull(),
  overageAbsorbed: integer('overage_absorbed').notNull(),
  overageByModel: jsonb('overage_by_model').$type<Record<string, number>>().notNull(),
  textCompleted: integer('text_completed').notNull(),
  textFailed: integer('text_failed').notNull(),
  textAborted: integer('text_aborted').notNull(),
  // P4 接入 ai_task 后填充这两个字段；null 表示尚未纳入统计。
  mediaSucceeded: integer('media_succeeded'),
  mediaFailed: integer('media_failed'),
  dataThrough: timestamp('data_through', { withTimezone: true }).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
})
export type MetricsDaily = typeof metricsDaily.$inferSelect
