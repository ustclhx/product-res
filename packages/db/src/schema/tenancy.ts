import { relations } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

/**
 * 租户（docs/03-data-model.md §2）：Better Auth organization 插件的表 + 扩展字段。
 * 来源与调整方式同 auth.ts（CLI 生成 → uuid / timestamptz / on delete restrict）。
 * `organization` 即 Workspace，只软删（`deleted_at`）、从不物理删除；
 * 所有者以 `member.role = 'owner'` 为唯一事实来源，不冗余 owner_id。
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

export const organization = pgTable('organization', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  // 扩展字段：个人空间标记与软删时间
  isPersonal: boolean('is_personal').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
})

export const member = pgTable(
  'member',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    // owner / admin / member
    role: text('role').notNull().default('member'),
    ...timestamps,
  },
  (t) => [
    unique('member_organization_id_user_id_unique').on(t.organizationId, t.userId),
    // 带 ws 的表统一建 (ws, id desc)，用于按空间分页列出（docs/03-data-model.md §7）
    index('member_organization_id_id_idx').on(t.organizationId, t.id.desc()),
    index('member_user_id_idx').on(t.userId),
  ],
)

export const invitation = pgTable(
  'invitation',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index('invitation_organization_id_id_idx').on(t.organizationId, t.id.desc()),
    index('invitation_email_idx').on(t.email),
  ],
)

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}))

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}))

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}))

export type Organization = typeof organization.$inferSelect
export type Member = typeof member.$inferSelect
export type Invitation = typeof invitation.$inferSelect
