import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

/** 用户首次进站的来源：注册时写入一次且不再更新，付款事件与订单归因都读这里。 */
export const userAttribution = pgTable('user_attribution', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  medium: text('medium'),
  campaign: text('campaign'),
  term: text('term'),
  content: text('content'),
  referrerHost: text('referrer_host'),
  landingPath: text('landing_path').notNull(),
  device: text('device'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  /** 注册请求的访问域名（已规范化）：多站部署按它把付款事件归到注册时所在的 site */
  signupHost: text('signup_host'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
export type UserAttribution = typeof userAttribution.$inferSelect

/** 服务端事件的投递占位：主键保证并发回调下同一笔付款只发送一次。 */
export const analyticsDelivery = pgTable('analytics_delivery', {
  eventKey: text('event_key').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
