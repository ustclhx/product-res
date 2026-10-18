import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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
 * 跟卖选品（openspec/changes/add-follow-selection design D2）。
 *
 * 与部署级的市场数据不同，方向、节点、品牌库、商品簇与线索都属于空间：每张表带 `workspace_id`，
 * feature 代码只经 `scoped(db, workspaceId)` 访问（lint 规则见 packages/db/lint）。
 * 跨表引用（方向 → 节点、簇 → 方向）只在同一空间内成立，由写入方保证。
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

/**
 * 7 个评分维度（方案第 5 节），与 packages/selection 的 DIMENSIONS 一致
 * （db 不能依赖 selection，取值在 apps/web 的单元测试中核对）。
 */
export const SELECTION_DIMENSIONS = [
  'market-demand',
  'growth-season',
  'peer-spread',
  'profit',
  'competition',
  'supply-timing',
  'compliance',
] as const
export type SelectionDimension = (typeof SELECTION_DIMENSIONS)[number]

export const DIRECTION_SELLER_STATUSES = ['seed', 'suggested', 'accepted', 'rejected'] as const
export type DirectionSellerStatus = (typeof DIRECTION_SELLER_STATUSES)[number]
export const BRAND_ENTRY_KINDS = ['brand', 'vero', 'registered'] as const
export type BrandEntryKind = (typeof BRAND_ENTRY_KINDS)[number]
export const RISK_RULE_KINDS = [
  'restricted-category',
  'hazmat',
  'certification',
  'shipping-ban',
] as const
export type RiskRuleKind = (typeof RISK_RULE_KINDS)[number]
/** 规则等级；风险发现另有 info（仅提示），与 packages/risk 的 RiskLevel 一致 */
export const RISK_LEVELS = ['high', 'medium', 'low'] as const
export type RiskLevelValue = (typeof RISK_LEVELS)[number]
export const RISK_FINDING_LEVELS = [...RISK_LEVELS, 'info'] as const
export const LEAD_STATUSES = ['new', 'costing', 'pending', 'followed', 'dropped'] as const
export const LEAD_GRADES = ['recommend', 'caution', 'reject'] as const
/** 与 packages/costing 的 FollowMode、costing_scenario.mode 一致 */
export const LEAD_FOLLOW_MODES = ['same-source', 'improved'] as const

/**
 * 线索的微改良参数，与 packages/costing 的 Improvement 一致（db 不依赖 costing，由写入方保证）；
 * 数值项可空表示尚未录入，note 为改良点说明。
 */
export interface LeadImprovement {
  /** 单价加成率（0.1 = 10%） */
  unitSurchargeRate?: number | null
  /** 一次性改款费（最小单位 + 币种），按计划数量分摊 */
  toolingCost?: { amountMinor: number; currency: string } | null
  sampleDays?: number | null
  note?: string | null
}

/** 选品方向：平台站点、类目、关键词与关联节点均可多选；停用后不进入每日流水线 */
export const direction = pgTable(
  'direction',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    /** 平台站点，取值同 marketplace_product.marketplace（如 ebay-us、amazon-us） */
    marketplaces: text('marketplaces').array().notNull().default(sql`'{}'::text[]`),
    categoryIds: text('category_ids').array().notNull().default(sql`'{}'::text[]`),
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    /** 关联 seasonal_node.id；节点删除时由写入方从数组中移除 */
    nodeIds: uuid('node_ids').array().notNull().default(sql`'{}'::uuid[]`),
    enabled: boolean('enabled').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('direction_workspace_name_idx').on(t.workspaceId, t.name),
    index('direction_workspace_enabled_idx').on(t.workspaceId, t.enabled),
  ],
)

/**
 * 方向的对标店铺池。拒绝的推荐保留为 rejected 行，之后的推荐据此排除；
 * 只有 seed 与 accepted 参与同行扩散计算。
 */
export const directionSeller = pgTable(
  'direction_seller',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    directionId: uuid('direction_id')
      .notNull()
      .references(() => direction.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    /** 平台卖家 ID（eBay 用户名 / Amazon Seller ID）；卖家可能尚未进入 marketplace_seller */
    sellerPlatformId: text('seller_platform_id').notNull(),
    sellerName: text('seller_name'),
    status: text('status', { enum: DIRECTION_SELLER_STATUSES }).notNull(),
    /** 系统推荐依据（如与已接受店铺同簇商品的重合数） */
    reason: jsonb('reason').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('direction_seller_key_idx').on(t.directionId, t.marketplace, t.sellerPlatformId),
    index('direction_seller_workspace_idx').on(t.workspaceId, t.directionId, t.status),
  ],
)

/**
 * 节点日历。日期是每年的起卖日（月、日），销售期从起卖日起算；
 * 母亲节、黑五等按星期计算的节点用近似日期，团队每年可修改。
 */
export const seasonalNode = pgTable(
  'seasonal_node',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    startMonth: smallint('start_month').notNull(),
    startDay: smallint('start_day').notNull(),
    salesDays: integer('sales_days').notNull(),
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    /** 由系统预置（可改可删，只用于界面标识） */
    preset: boolean('preset').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('seasonal_node_workspace_name_idx').on(t.workspaceId, t.name),
    check('seasonal_node_month_valid', sql`${t.startMonth} between 1 and 12`),
    check('seasonal_node_day_valid', sql`${t.startDay} between 1 and 31`),
    check('seasonal_node_sales_days_positive', sql`${t.salesDays} between 1 and 366`),
  ],
)

/** 品牌库：普通品牌、VeRO 权利人、Amazon 品牌备案；marketplace 为空表示所有平台 */
export const brandEntry = pgTable(
  'brand_entry',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: BRAND_ENTRY_KINDS }).notNull(),
    marketplace: text('marketplace'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_entry_workspace_kind_idx').on(t.workspaceId, t.kind)],
)

/**
 * 风险规则匹配条件，与 packages/risk 的 RiskRule.match 一致：类目 ID 或商品属性任一命中即触发，
 * platform 为空表示不限平台。
 */
export interface RiskRuleMatch {
  platform?: 'amazon' | 'ebay'
  categoryIds?: string[]
  /** 商品属性，如 battery / liquid / children */
  attributes?: string[]
}

export const riskRule = pgTable(
  'risk_rule',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    kind: text('kind', { enum: RISK_RULE_KINDS }).notNull(),
    match: jsonb('match').$type<RiskRuleMatch>().notNull().default({}),
    level: text('level', { enum: RISK_LEVELS }).notNull(),
    description: text('description').notNull(),
    /** 命中即一票否决 */
    veto: boolean('veto').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('risk_rule_workspace_kind_idx').on(t.workspaceId, t.kind)],
)

/** 硬门槛开关（design D5），键与 packages/selection 的 ScoringSettings.gates 一致 */
export interface ScoringHardGates {
  /** 合规分低于否决阈值即否决 */
  compliance: boolean
  /** 所有物流方案都来不及 */
  timing: boolean
  /** 毛利率低于底线（无利润数据时不判） */
  margin: boolean
}

/** 评分设置：只追加，每次修改生成新版本；线索记录生成时的版本号 */
export const scoringSetting = pgTable(
  'scoring_setting',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    version: integer('version').notNull(),
    weights: jsonb('weights').$type<Record<SelectionDimension, number>>().notNull(),
    reverseDimensions: text('reverse_dimensions').array().notNull(),
    vetoThreshold: integer('veto_threshold').notNull(),
    /** 可计算维度少于此数不给综合分 */
    minDimensions: integer('min_dimensions').notNull(),
    hardGates: jsonb('hard_gates').$type<ScoringHardGates>().notNull(),
    /** 毛利底线，基点（1500 = 15%） */
    marginFloorBp: integer('margin_floor_bp').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('scoring_setting_workspace_version_idx').on(t.workspaceId, t.version),
    check('scoring_setting_version_positive', sql`${t.version} > 0`),
    check('scoring_setting_veto_range', sql`${t.vetoThreshold} between 0 and 100`),
    check('scoring_setting_min_dimensions_range', sql`${t.minDimensions} between 1 and 7`),
  ],
)

/** 商品簇：同一方向、同一平台下的同款商品 */
export const cluster = pgTable(
  'cluster',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    // 有簇的方向不能删除，只能停用，历史线索保留可查
    directionId: uuid('direction_id')
      .notNull()
      .references(() => direction.id, { onDelete: 'restrict' }),
    marketplace: text('marketplace').notNull(),
    representativeProductId: uuid('representative_product_id').references(
      () => marketplaceProduct.id,
      { onDelete: 'set null' },
    ),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'merged', 'archived'] })
      .notNull()
      .default('active'),
    /** 被合并进的簇 */
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('cluster_workspace_direction_idx').on(t.workspaceId, t.directionId, t.status)],
)

export const clusterMember = pgTable(
  'cluster_member',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => marketplaceProduct.id, { onDelete: 'restrict' }),
    method: text('method', { enum: ['gtin', 'platform-id', 'title', 'manual'] }).notNull(),
    /** 归并置信度 0–1 */
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
    /** 手动拆分 / 合并后锁定，自动归并不覆盖 */
    locked: boolean('locked').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cluster_member_cluster_product_idx').on(t.clusterId, t.productId),
    index('cluster_member_workspace_product_idx').on(t.workspaceId, t.productId),
    check('cluster_member_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
)

/** 簇 × 日期 × 维度的信号分；缺失输入时 score 为空，不按 0 计 */
export const clusterSignal = pgTable(
  'cluster_signal',
  {
    workspaceId: workspaceId(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'cascade' }),
    observedOn: date('observed_on').notNull(),
    dimension: text('dimension', { enum: SELECTION_DIMENSIONS }).notNull(),
    score: numeric('score', { precision: 5, scale: 2, mode: 'number' }),
    /** 输入值与来源引用（观测值主键、来源、获取方式与时间） */
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.observedOn, t.dimension] }),
    index('cluster_signal_workspace_day_idx').on(t.workspaceId, t.observedOn),
    check('cluster_signal_score_range', sql`${t.score} between 0 and 100`),
  ],
)

/** 线索：簇 × 日期唯一，重复运行按此 upsert */
export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'restrict' }),
    directionId: uuid('direction_id')
      .notNull()
      .references(() => direction.id, { onDelete: 'restrict' }),
    leadOn: date('lead_on').notNull(),
    /** 可计算维度不足时为空 */
    score: numeric('score', { precision: 5, scale: 2, mode: 'number' }),
    /** 计算出的等级；冷启动时界面显示“未验证”，这里仍保存计算结果 */
    grade: text('grade', { enum: LEAD_GRADES }),
    /** 总置信度 0–1 */
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    /** 置信度明细与硬门槛结果 */
    confidenceDetail: jsonb('confidence_detail').$type<Record<string, unknown>>(),
    gates: jsonb('gates').$type<Record<string, unknown>>().notNull().default({}),
    vetoed: boolean('vetoed').notNull().default(false),
    latestDecisionOn: date('latest_decision_on'),
    settingVersion: integer('setting_version').notNull(),
    status: text('status', { enum: LEAD_STATUSES }).notNull().default('new'),
    /** 跟卖方式：核算矩阵按此默认，切换对比时写回 */
    followMode: text('follow_mode', { enum: LEAD_FOLLOW_MODES }).notNull().default('same-source'),
    /** 微改良参数；只有改良点说明（如品类洞察转入）时数值项为空，核算报告缺少“微改良参数” */
    improvement: jsonb('improvement').$type<LeadImprovement>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('lead_cluster_day_idx').on(t.clusterId, t.leadOn),
    index('lead_workspace_direction_day_idx').on(t.workspaceId, t.directionId, t.leadOn),
    check('lead_score_range', sql`${t.score} between 0 and 100`),
    check('lead_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
)

/** 线索事件流：状态变化、手动拆分 / 合并、备注 */
export const leadEvent = pgTable(
  'lead_event',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    leadId: uuid('lead_id').references(() => lead.id, { onDelete: 'cascade' }),
    clusterId: uuid('cluster_id').references(() => cluster.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['status', 'split', 'merge', 'note'] }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('lead_event_lead_idx').on(t.leadId, t.createdAt),
    index('lead_event_workspace_cluster_idx').on(t.workspaceId, t.clusterId, t.createdAt),
  ],
)

/** 风险发现：簇 × 风险类型 × 依据（规则 ID 或品牌名）唯一 */
export const riskFinding = pgTable(
  'risk_finding',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'cascade' }),
    /** packages/risk 的 RiskType（brand / vero / brand-registry / design-patent …） */
    kind: text('kind').notNull(),
    /** 命中的规则 ID / 品牌名等；无具体依据对象时为空串 */
    ref: text('ref').notNull().default(''),
    level: text('level', { enum: RISK_FINDING_LEVELS }).notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    veto: boolean('veto').notNull().default(false),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('risk_finding_key_idx').on(t.clusterId, t.kind, t.ref),
    index('risk_finding_workspace_idx').on(t.workspaceId, t.clusterId),
  ],
)

export type Direction = typeof direction.$inferSelect
export type DirectionSeller = typeof directionSeller.$inferSelect
export type SeasonalNode = typeof seasonalNode.$inferSelect
export type BrandEntry = typeof brandEntry.$inferSelect
export type RiskRule = typeof riskRule.$inferSelect
export type ScoringSetting = typeof scoringSetting.$inferSelect
