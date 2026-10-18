import { newId } from '@product-res/shared'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** 等候名单按规范化邮箱去重，邀请凭据只保存在服务端。 */
export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  email: text('email').notNull().unique(),
  invitationNonce: uuid('invitation_nonce'),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  invitationExpiresAt: timestamp('invitation_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

/** 每次重新订阅换确认凭据，旧确认链接不能恢复已退订的订阅。 */
export const newsletterSubscriber = pgTable(
  'newsletter_subscriber',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    email: text('email').notNull().unique(),
    status: text('status', { enum: ['pending', 'confirmed', 'unsubscribed'] })
      .notNull()
      .default('pending'),
    confirmToken: uuid('confirm_token').notNull().$defaultFn(newId),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('newsletter_subscriber_status_id_idx').on(t.status, t.id)],
)
