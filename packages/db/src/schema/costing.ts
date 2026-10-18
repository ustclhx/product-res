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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { dataImport } from './marketdata.ts'
import { cluster, lead } from './selection.ts'
import { organization } from './tenancy.ts'

/**
 * 成本核算与决策（openspec/changes/add-costing-decisions design D1）。
 *
 * 全部为空间级表，带 `workspace_id`，feature 代码只经 `scoped(db, workspaceId)` 访问。
 * 金额一律为最小单位整数并带显式币种；比例用小数（0.15 = 15%）。取值枚举与 packages/costing 的类型一致
 * （db 不能依赖 costing，由写入方的类型检查保证）。
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
const rate = (name: string) => numeric(name, { precision: 6, scale: 4, mode: 'number' })

export const SUPPLIER_PLATFORMS = ['1688', 'alibaba', 'other'] as const
export const QUOTE_CONFIDENCES = ['public', 'confirmed'] as const
export const QUOTE_SOURCES = ['manual', 'import'] as const
export const COSTING_PLATFORMS = ['amazon', 'ebay'] as const
export const LOGISTICS_TYPES = ['ebay-direct', 'ebay-overseas', 'amazon-fba', 'amazon-fbm'] as const
export const FOLLOW_MODES = ['same-source', 'improved'] as const
export const DECISION_KINDS = ['follow', 'drop'] as const
/** 放弃原因（方案第 9 节）：利润不够 / 竞争太多 / 时间来不及 / 货源不行 / 侵权风险 / 其他 */
export const DROP_REASONS = [
  'low-margin',
  'competition',
  'timing',
  'supply',
  'infringement',
  'other',
] as const

export interface QuoteTier {
  minQty: number
  unitPriceMinor: number
}

/** 计费公式，与 packages/costing 的 ShippingFormula 一致（first-additional / volume） */
export type ShippingFormulaJson = Record<string, unknown>

/** 供应商：1688 / Alibaba / 其他 */
export const supplier = pgTable(
  'supplier',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    url: text('url'),
    platform: text('platform', { enum: SUPPLIER_PLATFORMS }).notNull().default('other'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('supplier_workspace_name_idx').on(t.workspaceId, t.name)],
)

/** 供应商 × 商品簇的报价；阶梯价按数量档保存 */
export const supplierQuote = pgTable(
  'supplier_quote',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' }),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => cluster.id, { onDelete: 'restrict' }),
    tiers: jsonb('tiers').$type<QuoteTier[]>().notNull(),
    currency: text('currency').notNull(),
    moq: integer('moq'),
    /** 单件实重（克）；未录入为空，核算时报告缺失而非按 0 计 */
    weightG: integer('weight_g'),
    /** 单件包装尺寸 */
    dimensions: jsonb('dimensions').$type<{
      lengthCm: number
      widthCm: number
      heightCm: number
    }>(),
    confidence: text('confidence', { enum: QUOTE_CONFIDENCES }).notNull(),
    quotedOn: date('quoted_on').notNull(),
    /** 报价给出的采购（生产 + 发货）天数 */
    procurementDays: integer('procurement_days'),
    source: text('source', { enum: QUOTE_SOURCES }).notNull().default('manual'),
    importId: uuid('import_id').references(() => dataImport.id, { onDelete: 'set null' }),
    note: text('note'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('supplier_quote_workspace_cluster_idx').on(t.workspaceId, t.clusterId, t.quotedOn),
    index('supplier_quote_supplier_idx').on(t.supplierId),
    check('supplier_quote_moq_positive', sql`${t.moq} is null or ${t.moq} > 0`),
    check('supplier_quote_weight_positive', sql`${t.weightG} is null or ${t.weightG} > 0`),
  ],
)

/** 物流方案：头程 / 直发 / 海外仓 / FBA 的计费公式与时效 */
export const logisticsProfile = pgTable(
  'logistics_profile',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    name: text('name').notNull(),
    platform: text('platform', { enum: COSTING_PLATFORMS }).notNull(),
    type: text('type', { enum: LOGISTICS_TYPES }).notNull(),
    transitDays: integer('transit_days').notNull(),
    /** 头程计费公式（海外仓与 FBA 必需） */
    headFreight: jsonb('head_freight').$type<ShippingFormulaJson>(),
    /** 直发运费或海外仓尾程公式 */
    lastMile: jsonb('last_mile').$type<ShippingFormulaJson>(),
    /** 禁运属性，如 battery / liquid */
    bannedAttributes: text('banned_attributes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('logistics_profile_workspace_name_idx').on(t.workspaceId, t.name),
    check('logistics_profile_transit_days_valid', sql`${t.transitDays} >= 0`),
  ],
)

/** 平台 × 类目的成本参数；category_id 为空表示该平台默认值，核算时先类目后默认 */
export const costParam = pgTable(
  'cost_param',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    platform: text('platform', { enum: COSTING_PLATFORMS }).notNull(),
    categoryId: text('category_id'),
    commissionRate: rate('commission_rate'),
    fixedFeeMinor: integer('fixed_fee_minor'),
    adRate: rate('ad_rate'),
    returnRate: rate('return_rate'),
    storageMonthlyMinor: integer('storage_monthly_minor'),
    storageMonths: numeric('storage_months', { precision: 5, scale: 2, mode: 'number' }),
    inboundFeeMinor: integer('inbound_fee_minor'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 空类目按空串参与唯一性，保证每个平台只有一份默认值
    uniqueIndex('cost_param_key_idx').on(
      t.workspaceId,
      t.platform,
      sql`coalesce(${t.categoryId}, '')`,
    ),
  ],
)

/** 核算方案：线索 × 报价 × 物流方案 × 跟卖方式；结果为计算时的快照，不随参数变化 */
export const costingScenario = pgTable(
  'costing_scenario',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => lead.id, { onDelete: 'cascade' }),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => supplierQuote.id, { onDelete: 'restrict' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => logisticsProfile.id, { onDelete: 'restrict' }),
    mode: text('mode', { enum: FOLLOW_MODES }).notNull(),
    plannedQty: integer('planned_qty').notNull(),
    salePriceMinor: integer('sale_price_minor'),
    currency: text('currency'),
    /** 微改良参数（单价加成、改款费） */
    improvement: jsonb('improvement').$type<Record<string, unknown>>(),
    /** 各成本项、保本价、毛利率、最晚决定日与输入来源；缺输入时为 { status: 'missing', ... } */
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    selected: boolean('selected').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('costing_scenario_key_idx').on(t.leadId, t.quoteId, t.profileId, t.mode),
    index('costing_scenario_workspace_lead_idx').on(t.workspaceId, t.leadId),
    check('costing_scenario_qty_positive', sql`${t.plannedQty} > 0`),
  ],
)

/** 决定：每条线索至多一个，之后不再改核算（可新建复制线索） */
export const decision = pgTable(
  'decision',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => lead.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: DECISION_KINDS }).notNull(),
    scenarioId: uuid('scenario_id').references(() => costingScenario.id, {
      onDelete: 'set null',
    }),
    firstBatchQty: integer('first_batch_qty'),
    targetPriceMinor: integer('target_price_minor'),
    currency: text('currency'),
    plannedListingOn: date('planned_listing_on'),
    dropReason: text('drop_reason', { enum: DROP_REASONS }),
    dropNote: text('drop_note'),
    /** 决定时的线索快照：分数、权重版本、所选组合、观测引用 */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('decision_lead_idx').on(t.leadId),
    index('decision_workspace_decided_idx').on(t.workspaceId, t.decidedAt.desc()),
    check('decision_drop_has_reason', sql`${t.kind} <> 'drop' or ${t.dropReason} is not null`),
    check(
      'decision_first_batch_positive',
      sql`${t.firstBatchQty} is null or ${t.firstBatchQty} > 0`,
    ),
  ],
)

/** 跟卖回看：决定 × 回看天数，实际销量与售价和预测对比 */
export const followOutcome = pgTable(
  'follow_outcome',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => decision.id, { onDelete: 'cascade' }),
    reviewDays: integer('review_days').notNull().default(30),
    actualUnits: integer('actual_units').notNull(),
    actualPriceMinor: integer('actual_price_minor'),
    currency: text('currency'),
    /** 与决定时预测的对比（预测销量 / 售价 / 毛利及差异） */
    comparison: jsonb('comparison').$type<Record<string, unknown>>().notNull().default({}),
    note: text('note'),
    recordedBy: uuid('recorded_by').references(() => user.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('follow_outcome_key_idx').on(t.decisionId, t.reviewDays),
    index('follow_outcome_workspace_idx').on(t.workspaceId, t.recordedAt),
    check('follow_outcome_units_valid', sql`${t.actualUnits} >= 0`),
  ],
)

export type Supplier = typeof supplier.$inferSelect
export type SupplierQuoteRow = typeof supplierQuote.$inferSelect
export type LogisticsProfileRow = typeof logisticsProfile.$inferSelect
export type CostParamRow = typeof costParam.$inferSelect
export type CostingScenarioRow = typeof costingScenario.$inferSelect
export type DecisionRow = typeof decision.$inferSelect
export type FollowOutcomeRow = typeof followOutcome.$inferSelect
