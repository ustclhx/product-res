import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
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

/**
 * 市场数据层（openspec/changes/add-data-source-hub）。
 *
 * 这些表是部署级的“市场数据仓库”，不带 workspace_id：数据源凭据和外部额度（如 eBay 每日 5000 次）
 * 属于整个部署，同一个商品的观测值对所有空间都相同。选品方向、线索、核算等业务表仍按空间隔离。
 */

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** 数据源的启用状态与非敏感配置；凭据只在部署层 secret 文件中 */
export const dataSource = pgTable('data_source', {
  id: text('id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** 同步频率（cron 或档位）、站点、安全线覆盖等非敏感配置 */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  /** 最近一次核验回执 */
  lastProbe: jsonb('last_probe').$type<Record<string, unknown>>(),
  /** 外部额度对账差异过大或凭据失效时暂停定时任务 */
  pausedReason: text('paused_reason'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** 每个数据源每个周期的额度状态；reserved + settled 不超过 hard_cap */
export const sourceBudget = pgTable(
  'source_budget',
  {
    sourceId: text('source_id').notNull(),
    /** day: YYYY-MM-DD，month: YYYY-MM，minute: YYYY-MM-DDTHH:mm（按数据源时区） */
    periodKey: text('period_key').notNull(),
    unit: text('unit').notNull(),
    hardCap: bigint('hard_cap', { mode: 'number' }).notNull(),
    safetyLine: bigint('safety_line', { mode: 'number' }).notNull(),
    reserved: bigint('reserved', { mode: 'number' }).notNull().default(0),
    settled: bigint('settled', { mode: 'number' }).notNull().default(0),
    /** 外部响应报告的剩余额度与时间，用于对账 */
    externalRemaining: bigint('external_remaining', { mode: 'number' }),
    externalCheckedAt: timestamp('external_checked_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.periodKey] })],
)

/** 额度账本：每次预扣 / 结算 / 释放 / 对账过期一行 */
export const budgetLedger = pgTable(
  'budget_ledger',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceId: text('source_id').notNull(),
    periodKey: text('period_key').notNull(),
    /** 同一任务的 reserve 与 settle/release 共用此 ID */
    reservationId: uuid('reservation_id').notNull(),
    kind: text('kind', { enum: ['reserve', 'settle', 'release', 'expire'] }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    mode: text('mode', { enum: ['scheduled', 'manual'] }).notNull(),
    runId: uuid('run_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('budget_ledger_reservation_idx').on(t.reservationId),
    index('budget_ledger_source_period_idx').on(t.sourceId, t.periodKey),
  ],
)

/** 同步运行记录 */
export const syncRun = pgTable(
  'sync_run',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceId: text('source_id').notNull(),
    dataKind: text('data_kind').notNull(),
    marketplace: text('marketplace').notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    trigger: text('trigger', { enum: ['scheduled', 'manual', 'replay'] }).notNull(),
    status: text('status', {
      enum: ['running', 'succeeded', 'failed', 'deferred', 'skipped'],
    }).notNull(),
    planned: bigint('planned', { mode: 'number' }).notNull().default(0),
    calls: integer('calls').notNull().default(0),
    cost: bigint('cost', { mode: 'number' }).notNull().default(0),
    okCount: integer('ok_count').notNull().default(0),
    failCount: integer('fail_count').notNull().default(0),
    /** 机器码，不含凭据或响应正文 */
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('sync_run_source_started_idx').on(t.sourceId, t.startedAt.desc()),
    index('sync_run_status_idx').on(t.status, t.startedAt.desc()),
  ],
)

/** 原始响应存档：对象存储（storage='s3'）或数据库内 gzip（storage='db'） */
export const rawPayload = pgTable(
  'raw_payload',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceId: text('source_id').notNull(),
    runId: uuid('run_id'),
    importId: uuid('import_id'),
    task: jsonb('task').$type<Record<string, unknown>>().notNull(),
    /** 已去掉凭据的请求摘要 */
    request: jsonb('request').$type<{ method: string; url: string }>().notNull(),
    status: integer('status').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull().default('application/json'),
    storage: text('storage', { enum: ['db', 's3'] }).notNull(),
    storageKey: text('storage_key'),
    body: bytea('body'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** 超过保留期清理后保留元数据，正文置空 */
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (t) => [
    index('raw_payload_run_idx').on(t.runId),
    index('raw_payload_source_fetched_idx').on(t.sourceId, t.fetchedAt.desc()),
    index('raw_payload_expires_idx').on(t.expiresAt).where(sql`${t.purgedAt} is null`),
  ],
)

/** 平台商品：平台 + 站点 + 平台 ID 唯一 */
export const marketplaceProduct = pgTable(
  'marketplace_product',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    marketplace: text('marketplace').notNull(),
    platformId: text('platform_id').notNull(),
    gtin: text('gtin'),
    title: text('title'),
    brand: text('brand'),
    categoryId: text('category_id'),
    imageUrl: text('image_url'),
    url: text('url'),
    sellerId: text('seller_id'),
    /** 上架时间；Amazon 取详情页 Date First Available */
    listedAt: timestamp('listed_at', { withTimezone: true }),
    /** 父体 ID（Amazon parent ASIN）；变体归并用 */
    parentPlatformId: text('parent_platform_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('marketplace_product_key_idx').on(t.marketplace, t.platformId),
    index('marketplace_product_seller_idx').on(t.marketplace, t.sellerId),
    index('marketplace_product_gtin_idx').on(t.gtin),
  ],
)

export const marketplaceSeller = pgTable(
  'marketplace_seller',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    marketplace: text('marketplace').notNull(),
    platformId: text('platform_id').notNull(),
    name: text('name'),
    url: text('url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('marketplace_seller_key_idx').on(t.marketplace, t.platformId)],
)

export const marketplaceKeyword = pgTable(
  'marketplace_keyword',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    marketplace: text('marketplace').notNull(),
    /** 小写、去首尾空白后的关键词 */
    phrase: text('phrase').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('marketplace_keyword_key_idx').on(t.marketplace, t.phrase)],
)

/** 可信度层级取值：0 真值、1 平台官方、2 页面展示、3 第三方估算、4 系统推算 */
export const OBSERVATION_TIERS = [0, 1, 2, 3, 4] as const

/**
 * 观测值长表：实体 × 指标 × 日期 × 来源 → 数值。同一来源同日重复写入以最新为准；
 * 多来源并存不覆盖；缺失就是没有行，不写 0。
 * 区间型信号（如 Amazon bought 徽标）写 value_low / value_high，value 为对数中点
 * （add-accuracy-store-tracking design D1）。
 */
export const observation = pgTable(
  'observation',
  {
    entityType: text('entity_type').notNull(),
    /** 对应 marketplace_product / marketplace_seller / marketplace_keyword 的 id；类目与币种用平台 ID 的稳定 UUID */
    entityId: uuid('entity_id').notNull(),
    metric: text('metric').notNull(),
    observedOn: date('observed_on').notNull(),
    sourceId: text('source_id').notNull(),
    value: numeric('value', { precision: 24, scale: 6, mode: 'number' }).notNull(),
    currency: text('currency'),
    method: text('method', { enum: ['official', 'estimate', 'derived', 'import'] }).notNull(),
    /** 可信度层级；主值先比层级（数字小者优先）。迁移按 method 回填 */
    tier: smallint('tier').notNull(),
    /** 区间下界；点值为空 */
    valueLow: numeric('value_low', { precision: 24, scale: 6, mode: 'number' }),
    /** 区间上界（不含）；点值或上界开放时为空 */
    valueHigh: numeric('value_high', { precision: 24, scale: 6, mode: 'number' }),
    /** 经由渠道（aisa / direct）；直接调用来源时为空 */
    channel: text('channel'),
    rawPayloadId: uuid('raw_payload_id'),
    importId: uuid('import_id'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId, t.metric, t.observedOn, t.sourceId] }),
    index('observation_metric_day_idx').on(t.metric, t.observedOn),
    index('observation_import_idx').on(t.importId),
    index('observation_source_day_idx').on(t.sourceId, t.observedOn),
    check('observation_tier_range', sql`${t.tier} between 0 and 4`),
  ],
)

/**
 * 来源 × 指标的主值资格（add-accuracy-store-tracking design D7）：部署级。
 * 人工抽检（4.1）计算一致率后写入；样本 ≥ 20 且一致率 < 95% 时 disqualified = true，
 * 读取主值时跳过该来源（packages/marketdata loadDisqualified）。没有行表示有资格。
 */
export const sourceQualification = pgTable(
  'source_qualification',
  {
    sourceId: text('source_id').notNull(),
    metric: text('metric').notNull(),
    disqualified: boolean('disqualified').notNull().default(false),
    /** 最近一次评估的一致率（0–1）与样本数 */
    agreementRate: numeric('agreement_rate', { precision: 6, scale: 5, mode: 'number' }),
    samples: integer('samples').notNull().default(0),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.metric] })],
)

/** 指标来源优先级：平台 × 指标 → 来源列表（第一个有值的为主值） */
export const metricPriority = pgTable(
  'metric_priority',
  {
    marketplace: text('marketplace').notNull(),
    metric: text('metric').notNull(),
    sources: text('sources').array().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.marketplace, t.metric] })],
)

/** 导入列映射模板 */
export const importTemplate = pgTable(
  'import_template',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceId: text('source_id').notNull(),
    name: text('name').notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    defaults: jsonb('defaults').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('import_template_source_name_idx').on(t.sourceId, t.name)],
)

/** 导入批次；撤销后观测值删除，批次与原文件保留 */
export const dataImport = pgTable(
  'data_import',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceId: text('source_id').notNull(),
    templateId: uuid('template_id'),
    fileName: text('file_name').notNull(),
    sha256: text('sha256').notNull(),
    rawPayloadId: uuid('raw_payload_id'),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    rowCount: integer('row_count').notNull(),
    importedCount: integer('imported_count').notNull(),
    skippedRows: integer('skipped_rows').notNull().default(0),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
  },
  (t) => [
    index('data_import_sha_idx').on(t.sha256),
    index('data_import_created_idx').on(t.createdAt.desc()),
  ],
)

/** 平台类目树（eBay Taxonomy 每周同步）；部署级，站点 × 类目 ID 唯一，每次同步整体覆盖 */
export const marketplaceCategory = pgTable(
  'marketplace_category',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    marketplace: text('marketplace').notNull(),
    categoryId: text('category_id').notNull(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    leaf: boolean('leaf').notNull().default(false),
    /** 从根到本节点的名称路径 */
    path: text('path').notNull(),
    treeVersion: text('tree_version').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('marketplace_category_uq').on(t.marketplace, t.categoryId),
    index('marketplace_category_name_idx').on(t.marketplace, t.name),
  ],
)

/** 数据质量问题；同一问题（fingerprint）重复出现只更新最近出现时间 */
export const dataQualityIssue = pgTable(
  'data_quality_issue',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    type: text('type', {
      enum: ['missing', 'spike', 'source-divergence', 'stale', 'sync-failure'],
    }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    sourceId: text('source_id'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    metric: text('metric'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['open', 'known', 'ignored', 'resolved'] })
      .notNull()
      .default('open'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('data_quality_issue_fingerprint_idx').on(t.fingerprint),
    index('data_quality_issue_status_idx').on(t.status, t.lastSeenAt.desc()),
  ],
)
