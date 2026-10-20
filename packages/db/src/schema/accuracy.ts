import { newId } from '@product-res/shared'
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { marketplaceProduct } from './marketdata.ts'
import { organization } from './tenancy.ts'

/**
 * 人工抽检（openspec/changes/add-accuracy-store-tracking design D7）：空间级，经 scoped() 访问。
 * 一致率按部署级来源统计后写入 source_qualification（见 marketdata.ts）。
 */

const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'restrict' })

export const ACCURACY_AUDIT_STATUSES = ['open', 'submitted'] as const

/** 每周一次的抽检：种子与抽样记录保存，便于复现 */
export const accuracyAudit = pgTable(
  'accuracy_audit',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    /** 抽检周的周一（YYYY-MM-DD） */
    weekOf: date('week_of').notNull(),
    seed: text('seed').notNull(),
    sampleSize: integer('sample_size').notNull(),
    /** 抽样记录：候选集大小、抽中的商品等 */
    sampling: jsonb('sampling').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: ACCURACY_AUDIT_STATUSES }).notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedBy: uuid('submitted_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('accuracy_audit_week_idx').on(t.workspaceId, t.weekOf)],
)

/** 抽检项：一个商品一行；collected 为各来源采集值，actual 为人工填写的页面实际值 */
export const accuracyAuditItem = pgTable(
  'accuracy_audit_item',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => accuracyAudit.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => marketplaceProduct.id, { onDelete: 'cascade' }),
    /** 来源 → 字段 → { value, low, high, fetchedAt } */
    collected: jsonb('collected').$type<Record<string, unknown>>().notNull().default({}),
    /** 字段 → 人工填写值；未填写为空 */
    actual: jsonb('actual').$type<Record<string, unknown>>(),
    /** 来源 → 字段 → 是否一致；提交后计算 */
    agreement: jsonb('agreement').$type<Record<string, Record<string, boolean>>>(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    checkedBy: uuid('checked_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('accuracy_audit_item_key_idx').on(t.auditId, t.productId),
    index('accuracy_audit_item_workspace_idx').on(t.workspaceId, t.auditId),
  ],
)

export type AccuracyAudit = typeof accuracyAudit.$inferSelect
export type AccuracyAuditItem = typeof accuracyAuditItem.$inferSelect
