import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { payment } from './billing.ts'
import { organization } from './tenancy.ts'

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

export const creditGrant = pgTable(
  'credit_grant',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    source: text('source', {
      enum: ['subscription', 'purchase', 'signup', 'admin', 'refund', 'promo'],
    }).notNull(),
    sourceRef: text('source_ref').notNull(),
    paymentId: uuid('payment_id').references(() => payment.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull(),
    remaining: integer('remaining').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    status: text('status', { enum: ['active', 'expired', 'revoked'] })
      .notNull()
      .default('active'),
    ...timestamps,
  },
  (t) => [
    unique('credit_grant_source_ref_unique').on(t.source, t.sourceRef),
    index('credit_grant_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('credit_grant_workspace_status_expiry_idx').on(t.workspaceId, t.status, t.expiresAt),
    check('credit_grant_amount_nonnegative', sql`${t.amount} >= 0`),
    check(
      'credit_grant_remaining_bounds',
      sql`${t.remaining} >= 0 and ${t.remaining} <= ${t.amount}`,
    ),
  ],
)

export const creditHold = pgTable(
  'credit_hold',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull(),
    status: text('status', { enum: ['held', 'captured', 'released'] })
      .notNull()
      .default('held'),
    refType: text('ref_type', { enum: ['ai_task', 'ai_message'] }).notNull(),
    refId: uuid('ref_id').notNull(),
    capturedAmount: integer('captured_amount').notNull().default(0),
    overageAbsorbed: integer('overage_absorbed').notNull().default(0),
    overageDebited: integer('overage_debited').notNull().default(0),
    overageDebt: integer('overage_debt').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('credit_hold_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    check(
      'credit_hold_amounts_nonnegative',
      sql`${t.amount} >= 0 and ${t.capturedAmount} >= 0 and ${t.overageAbsorbed} >= 0 and ${t.overageDebited} >= 0 and ${t.overageDebt} >= 0`,
    ),
  ],
)

/** One debt balance per workspace; the workspace UUID is the primary key (docs/03 §4). */
export const creditDebt = pgTable(
  'credit_debt',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull().default(0),
    ...timestamps,
  },
  (t) => [check('credit_debt_amount_nonnegative', sql`${t.amount} >= 0`)],
)

/** Allocations belong to a hold; access via the workspace-scoped hold, never by grant alone. */
export const creditHoldAllocation = pgTable(
  'credit_hold_allocation',
  {
    holdId: uuid('hold_id')
      .notNull()
      .references(() => creditHold.id, { onDelete: 'restrict' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => creditGrant.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.holdId, t.grantId] }),
    index('credit_hold_allocation_grant_id_idx').on(t.grantId),
    check('credit_hold_allocation_amount_positive', sql`${t.amount} > 0`),
  ],
)

/** Append-only audit entries; mutation rules are enforced by the credits package (task 2.7). */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'restrict' }),
    grantId: uuid('grant_id').references(() => creditGrant.id, { onDelete: 'restrict' }),
    delta: integer('delta').notNull(),
    type: text('type', {
      enum: ['grant', 'consume', 'expire', 'refund', 'revoke', 'adjust', 'debt', 'debt_repay'],
    }).notNull(),
    // External references include hashed emails and payment:month keys, not only UUIDs.
    refType: text('ref_type'),
    refId: text('ref_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_ledger_workspace_id_id_idx').on(t.workspaceId, t.id.desc())],
)

export type CreditGrant = typeof creditGrant.$inferSelect
export type CreditHold = typeof creditHold.$inferSelect
export type CreditDebt = typeof creditDebt.$inferSelect
export type CreditHoldAllocation = typeof creditHoldAllocation.$inferSelect
export type CreditLedger = typeof creditLedger.$inferSelect
