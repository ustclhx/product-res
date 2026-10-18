import { relations } from 'drizzle-orm'
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { invitation, member, organization } from './tenancy.ts'

/**
 * Better Auth 管理的表（docs/03-data-model.md §1）。
 *
 * 由 Better Auth CLI（`auth generate`，better-auth 1.7.7，启用全部插件）生成后手动调整：
 * - id 与外键列改为 `uuid`，主键由 `advanced.database.generateId` 生成 UUIDv7（design.md 决策 2）；
 * - 时间列改为 `timestamptz`，各表补 `created_at` / `updated_at` 默认值；
 * - 外键一律 `on delete restrict`（docs/03-data-model.md §7）：user 只匿名化、从不物理删除；
 * - 扩展字段 `user.locale` / `user.timezone`。
 * 字段名（TS 属性名）必须与 Better Auth 的模型字段一致，否则 drizzle adapter 的 schema 校验会失败；
 * 升级 Better Auth 后重新运行 CLI 对比差异。
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

export const user = pgTable('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // admin 插件：平台角色（user / admin）与封禁
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  // twoFactor 插件
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  // 扩展字段
  locale: text('locale'),
  timezone: text('timezone'),
  ...timestamps,
})

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    // organization 插件：当前活跃空间（只用于 /app 的重定向，docs/04-auth-and-tenancy.md §3）
    activeOrganizationId: uuid('active_organization_id').references(() => organization.id, {
      onDelete: 'restrict',
    }),
    // admin 插件：模拟登录的发起人
    impersonatedBy: uuid('impersonated_by').references(() => user.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const twoFactor = pgTable(
  'two_factor',
  {
    id: uuid('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('two_factor_secret_idx').on(t.secret),
    index('two_factor_user_id_idx').on(t.userId),
  ],
)

/**
 * api-key 插件（`@better-auth/api-key`）。插件配置为 `references: 'user'`，
 * 因此 `reference_id` 指向 user；所属 workspace 记在 `metadata` 中（docs/03-data-model.md §1）。
 */
export const apikey = pgTable(
  'apikey',
  {
    id: uuid('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: uuid('reference_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    permissions: text('permissions'),
    metadata: text('metadata'),
    ...timestamps,
  },
  (t) => [
    index('apikey_config_id_idx').on(t.configId),
    index('apikey_reference_id_idx').on(t.referenceId),
    index('apikey_key_idx').on(t.key),
  ],
)

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
  twoFactors: many(twoFactor),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}))

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}))

export type User = typeof user.$inferSelect
export type Session = typeof session.$inferSelect
