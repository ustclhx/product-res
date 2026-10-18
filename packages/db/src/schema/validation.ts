import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import {
  cluster,
  direction,
  LEAD_GRADES,
  lead,
  SELECTION_DIMENSIONS,
  type SelectionDimension,
} from './selection.ts'
import { organization } from './tenancy.ts'

/**
 * 影子验证（openspec/changes/add-shadow-validation design D1）：推荐冻结、到期打标签、准备度与权重建议。
 * 全部为空间级表。取值枚举与 packages/selection 的 SampleKind / Readiness 一致。
 */

const workspaceId = () =>
  uuid('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'restrict' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const ratio = (name: string) => numeric(name, { precision: 6, scale: 5, mode: 'number' })

export const SAMPLE_KINDS = ['shadow', 'replay', 'import'] as const
export type SampleKindValue = (typeof SAMPLE_KINDS)[number]
export const LABEL_OUTCOMES = ['hit', 'miss', 'insufficient'] as const
export const LABEL_WINDOWS = [14, 30, 60] as const
export const READINESS_LEVELS = ['cold-start', 'observation', 'usable', 'trusted'] as const
export const WEIGHT_SUGGESTION_STATUSES = ['proposed', 'accepted', 'dismissed'] as const

/**
 * 冻结的推荐。线索 × 冻结日唯一；回放样本没有线索，另按簇 × 冻结日 × 样本类型唯一。
 * 冻结后输入引用快照不再修改，标签据此公平回看。
 */
export const recommendation = pgTable(
  'recommendation',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    leadId: uuid('lead_id').references(() => lead.id, { onDelete: 'set null' }),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'restrict' }),
    directionId: uuid('direction_id')
      .notNull()
      .references(() => direction.id, { onDelete: 'restrict' }),
    frozenOn: date('frozen_on').notNull(),
    marketplace: text('marketplace').notNull(),
    /** 主导维度（信号类型） */
    signalType: text('signal_type', { enum: SELECTION_DIMENSIONS }).notNull(),
    score: numeric('score', { precision: 5, scale: 2, mode: 'number' }).notNull(),
    grade: text('grade', { enum: LEAD_GRADES }).notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    settingVersion: integer('setting_version').notNull(),
    /** 输入引用快照（观测值主键、来源、时间） */
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull(),
    sampleKind: text('sample_kind', { enum: SAMPLE_KINDS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recommendation_lead_day_idx').on(t.leadId, t.frozenOn),
    uniqueIndex('recommendation_cluster_day_kind_idx').on(t.clusterId, t.frozenOn, t.sampleKind),
    index('recommendation_workspace_frozen_idx').on(t.workspaceId, t.frozenOn),
    index('recommendation_stat_idx').on(t.workspaceId, t.marketplace, t.directionId, t.signalType),
    check('recommendation_score_range', sql`${t.score} between 0 and 100`),
  ],
)

/** 推荐 × 窗口的标签；数据不足时为 insufficient，不计入命中率分母 */
export const recommendationLabel = pgTable(
  'recommendation_label',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendation.id, { onDelete: 'cascade' }),
    windowDays: smallint('window_days').notNull(),
    outcome: text('outcome', { enum: LABEL_OUTCOMES }).notNull(),
    /** 窗口内簇销量增量 */
    salesDelta: numeric('sales_delta', { precision: 12, scale: 2, mode: 'number' }),
    /** 竞品中位价跌幅（0.15 = 跌 15%） */
    priceDropRate: ratio('price_drop_rate'),
    /** 季节类：高峰周预测误差（周） */
    peakWeekError: numeric('peak_week_error', { precision: 5, scale: 1, mode: 'number' }),
    /** 所用观测来源 */
    sources: jsonb('sources').$type<Record<string, unknown>>().notNull().default({}),
    labeledAt: timestamp('labeled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recommendation_label_key_idx').on(t.recommendationId, t.windowDays),
    index('recommendation_label_workspace_idx').on(t.workspaceId, t.windowDays, t.outcome),
    check('recommendation_label_window_valid', sql`${t.windowDays} in (14, 30, 60)`),
  ],
)

/** 准备度统计：平台 × 方向 × 信号类型 × 计算日 */
export const readinessStat = pgTable(
  'readiness_stat',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    marketplace: text('marketplace').notNull(),
    directionId: uuid('direction_id')
      .notNull()
      .references(() => direction.id, { onDelete: 'cascade' }),
    signalType: text('signal_type', { enum: SELECTION_DIMENSIONS }).notNull(),
    computedOn: date('computed_on').notNull(),
    shadowCount: integer('shadow_count').notNull().default(0),
    replayCount: integer('replay_count').notNull().default(0),
    importCount: integer('import_count').notNull().default(0),
    hitCount: integer('hit_count').notNull().default(0),
    /** 加权有效样本数 */
    effectiveSamples: numeric('effective_samples', { precision: 10, scale: 2, mode: 'number' })
      .notNull()
      .default(0),
    wilsonLower: ratio('wilson_lower'),
    /** 同方向随机新品基线命中率 */
    baseline: ratio('baseline'),
    level: text('level', { enum: READINESS_LEVELS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('readiness_stat_key_idx').on(
      t.workspaceId,
      t.marketplace,
      t.directionId,
      t.signalType,
      t.computedOn,
    ),
  ],
)

/** 权重建议：需团队点“采用”才生成新评分设置版本 */
export const weightSuggestion = pgTable(
  'weight_suggestion',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    fittedAt: timestamp('fitted_at', { withTimezone: true }).notNull().defaultNow(),
    sampleCount: integer('sample_count').notNull(),
    suggestedWeights: jsonb('suggested_weights')
      .$type<Record<SelectionDimension, number>>()
      .notNull(),
    currentWeights: jsonb('current_weights').$type<Record<SelectionDimension, number>>().notNull(),
    /** 交叉验证指标：AUC、命中率提升等 */
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: WEIGHT_SUGGESTION_STATUSES }).notNull().default('proposed'),
    resolvedBy: uuid('resolved_by').references(() => user.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('weight_suggestion_workspace_idx').on(t.workspaceId, t.fittedAt.desc())],
)

export type Recommendation = typeof recommendation.$inferSelect
export type RecommendationLabel = typeof recommendationLabel.$inferSelect
export type ReadinessStat = typeof readinessStat.$inferSelect
export type WeightSuggestion = typeof weightSuggestion.$inferSelect
