import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { marketplaceProduct } from './marketdata.ts'
import { organization } from './tenancy.ts'

/**
 * 品类洞察（openspec/changes/add-category-insight design D1）。
 * category_study / category_study_snapshot 是空间级；marketplace_review 与市场数据一样是部署级（无 workspace_id）。
 */

const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'restrict' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const CATEGORY_STUDY_STATUSES = ['active', 'archived'] as const

/** 品类研究：站点 + 类目 + 关键词 + 头部 N */
export const categoryStudy = pgTable(
  'category_study',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** 平台站点，取值同 marketplace_product.marketplace */
    marketplace: text('marketplace').notNull(),
    categoryIds: text('category_ids').array().notNull().default(sql`'{}'::text[]`),
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    topN: integer('top_n').notNull().default(20),
    status: text('status', { enum: CATEGORY_STUDY_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('category_study_workspace_name_idx').on(t.workspaceId, t.name),
    check('category_study_top_n_range', sql`${t.topN} between 1 and 100`),
  ],
)

/** 研究快照：只追加，报告页默认显示最新一份 */
export const categoryStudySnapshot = pgTable(
  'category_study_snapshot',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    studyId: uuid('study_id')
      .notNull()
      .references(() => categoryStudy.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 数据截止日期：快照所用观测值的最晚日期 */
    dataAsOf: date('data_as_of'),
    /** 各模块结果，每个数值带来源引用 */
    modules: jsonb('modules').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('category_study_snapshot_study_idx').on(t.studyId, t.generatedAt.desc())],
)

/** 商品评论（部署级）：商品 × 平台评论 ID 唯一，重复写入按此 upsert */
export const marketplaceReview = pgTable(
  'marketplace_review',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    productId: uuid('product_id')
      .notNull()
      .references(() => marketplaceProduct.id, { onDelete: 'cascade' }),
    reviewId: text('review_id').notNull(),
    /** 1–5；来源未给评分时为空 */
    rating: smallint('rating'),
    title: text('title'),
    body: text('body'),
    reviewedOn: date('reviewed_on'),
    sourceId: text('source_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('marketplace_review_key_idx').on(t.productId, t.reviewId),
    index('marketplace_review_product_rating_idx').on(t.productId, t.rating),
    check(
      'marketplace_review_rating_range',
      sql`${t.rating} is null or ${t.rating} between 1 and 5`,
    ),
  ],
)

export type CategoryStudy = typeof categoryStudy.$inferSelect
export type CategoryStudySnapshot = typeof categoryStudySnapshot.$inferSelect
export type MarketplaceReview = typeof marketplaceReview.$inferSelect
