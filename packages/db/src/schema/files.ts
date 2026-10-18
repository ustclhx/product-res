import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { aiTask } from './ai.ts'
import { user } from './auth.ts'
import { organization } from './tenancy.ts'

/** pending 只保存上传声明；确认真实大小与类型后 ready 才可访问并计入配额。 */
export const file = pgTable(
  'file',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    purpose: text('purpose', { enum: ['upload', 'ai_output', 'avatar'] }).notNull(),
    status: text('status', { enum: ['pending', 'ready'] })
      .notNull()
      .default('pending'),
    r2Key: text('r2_key').notNull().unique(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    // 秒数允许小数，保留媒体服务商返回的实际时长。
    duration: doublePrecision('duration'),
    sourceTaskId: uuid('source_task_id').references(() => aiTask.id, { onDelete: 'restrict' }),
    publicToken: text('public_token').unique(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('file_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('file_status_created_at_idx').on(t.status, t.createdAt),
    check('file_status_valid', sql`${t.status} in ('pending', 'ready')`),
    check('file_size_nonnegative', sql`${t.size} >= 0`),
    check('file_dimensions_positive', sql`${t.width} > 0 and ${t.height} > 0`),
    check('file_duration_nonnegative', sql`${t.duration} >= 0`),
  ],
)

export type File = typeof file.$inferSelect
export type NewFile = typeof file.$inferInsert
