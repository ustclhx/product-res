import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { marketplaceProduct } from './marketdata.ts'
import { organization } from './tenancy.ts'

/**
 * 店铺追踪（openspec/changes/add-accuracy-store-tracking design D4、D5）。
 *
 * - tracked_store / tracked_product 属于空间配置，带 workspace_id，只经 scoped() 访问；
 * - store_listing 记录“店铺 × 商品”的出现时间，与市场数据一样是部署级（不带 workspace_id）。
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

export const STORE_PLATFORMS = ['ebay', 'amazon'] as const
export type StorePlatform = (typeof STORE_PLATFORMS)[number]
/** 对标 / 热门 / 观察 */
export const TRACKED_STORE_KINDS = ['benchmark', 'hot', 'watch'] as const
export const TRACKED_STORE_STATUSES = ['active', 'paused', 'removed'] as const
/** 店铺新品的发现方式：eBay Browse 卖家新品 / Amazon 关键词搜索 + 报价归属 */
export const STORE_LISTING_DISCOVERIES = ['browse-seller', 'search-offer'] as const
/** 被追踪商品档位：热点每日、普通每 5 天、冷门停追 */
export const TRACKED_PRODUCT_TIERS = ['hot', 'normal', 'cold'] as const
export type TrackedProductTier = (typeof TRACKED_PRODUCT_TIERS)[number]
/** 进入追踪的来源：店铺池商品 / 线索商品 / 人工加入 */
export const TRACKED_PRODUCT_ORIGINS = ['store', 'lead', 'manual'] as const

/** 店铺池（空间级）：粘贴链接解析出平台卖家 ID；与方向的对标店铺并存 */
export const trackedStore = pgTable(
  'tracked_store',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    platform: text('platform', { enum: STORE_PLATFORMS }).notNull(),
    /** 平台站点，取值同 marketplace_product.marketplace（如 ebay-us、amazon-us） */
    marketplace: text('marketplace').notNull(),
    /** eBay 用户名或店铺名；Amazon 卖家 ID */
    sellerKey: text('seller_key').notNull(),
    displayName: text('display_name'),
    url: text('url'),
    kind: text('kind', { enum: TRACKED_STORE_KINDS }).notNull(),
    reason: text('reason'),
    status: text('status', { enum: TRACKED_STORE_STATUSES }).notNull().default('active'),
    /** 关联选品方向（direction.id）；方向删除时由写入方移除 */
    directionIds: uuid('direction_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Amazon 店铺的发现搜索词（1–5 个）；为空时取关联方向的关键词 */
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tracked_store_key_idx').on(t.workspaceId, t.marketplace, t.sellerKey),
    index('tracked_store_workspace_status_idx').on(t.workspaceId, t.status),
  ],
)

/** 店铺 × 商品（部署级）：首次发现、最近出现、下架日期 */
export const storeListing = pgTable(
  'store_listing',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    platform: text('platform', { enum: STORE_PLATFORMS }).notNull(),
    sellerKey: text('seller_key').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => marketplaceProduct.id, { onDelete: 'cascade' }),
    firstSeenOn: date('first_seen_on').notNull(),
    lastSeenOn: date('last_seen_on').notNull(),
    delistedOn: date('delisted_on'),
    discovery: text('discovery', { enum: STORE_LISTING_DISCOVERIES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('store_listing_key_idx').on(t.platform, t.sellerKey, t.productId),
    index('store_listing_seller_seen_idx').on(t.platform, t.sellerKey, t.firstSeenOn.desc()),
    index('store_listing_product_idx').on(t.productId),
  ],
)

/** 被追踪商品（空间级）：档位与变更原因；同一空间同一商品一行 */
export const trackedProduct = pgTable(
  'tracked_product',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: workspaceId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => marketplaceProduct.id, { onDelete: 'cascade' }),
    tier: text('tier', { enum: TRACKED_PRODUCT_TIERS }).notNull().default('normal'),
    /** 最近一次档位变更的原因（如 new-lead、bought-up、stale-30d、manual） */
    tierReason: text('tier_reason'),
    tierChangedAt: timestamp('tier_changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** 首次进入追踪的来源 */
    origin: text('origin', { enum: TRACKED_PRODUCT_ORIGINS }).notNull(),
    /** 来源对象 ID（tracked_store.id / lead.id），人工加入为空 */
    originRef: uuid('origin_ref'),
    lastSnapshotOn: date('last_snapshot_on'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tracked_product_key_idx').on(t.workspaceId, t.productId),
    index('tracked_product_workspace_tier_idx').on(t.workspaceId, t.tier),
  ],
)

export type TrackedStore = typeof trackedStore.$inferSelect
export type StoreListing = typeof storeListing.$inferSelect
export type TrackedProduct = typeof trackedProduct.$inferSelect
