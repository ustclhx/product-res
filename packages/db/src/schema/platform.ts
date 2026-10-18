import { newId } from '@product-res/shared'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { organization } from './tenancy.ts'

/**
 * 运行时设置（docs/02-project-structure.md「配置体系」）：可在后台修改、不发版生效的项。
 * 每个 key 在代码中都有默认值（见 src/settings.ts），表中缺失时回退到默认值。
 */
export const setting = pgTable('setting', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  key: text('key').notNull().unique(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export type Setting = typeof setting.$inferSelect
export type NewSetting = typeof setting.$inferInsert

/**
 * 审计日志（docs/03-data-model.md §6）：管理员操作、计费关键变更、成员变更。
 * 只增不改，永久保留；用户删号后 `actor_user_id` 仍指向已匿名化的 user 行（§7）。
 * `actor_user_id` 为空表示系统操作（Cron、Webhook 等）。
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => organization.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('audit_log_actor_user_id_id_idx').on(t.actorUserId, t.id.desc()),
  ],
)

export type AuditLog = typeof auditLog.$inferSelect
export type NewAuditLog = typeof auditLog.$inferInsert

/** 站内通知（docs/03-data-model.md §6）。`workspace_id` 为空表示与具体空间无关的通知。 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => organization.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('notification_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    // 通知中心按用户列出
    index('notification_user_id_id_idx').on(t.userId, t.id.desc()),
  ],
)

export type Notification = typeof notification.$inferSelect
export type NewNotification = typeof notification.$inferInsert
