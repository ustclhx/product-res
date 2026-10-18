import { newId } from '@product-res/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { JsonValue, PaymentProviderId } from './billing.ts'
import { organization } from './tenancy.ts'

interface SubscriptionCompensationDetails {
  provider: PaymentProviderId
  providerSubscriptionId: string
  planId: string
  planPriceId: string
  payment?: {
    providerPaymentId: string
    kind: 'initial' | 'renewal' | 'adjustment'
    amount: number
    currency: string
    paidAt: string
    periodStart: string
    periodEnd: string
    refundedAmount: number | null
    raw: JsonValue
  }
}

export type SubscriptionCompensationPayload = SubscriptionCompensationDetails &
  (
    | { reason?: 'subscription_conflict'; winnerSubscriptionId: string }
    | { reason: 'workspace_deleted'; winnerSubscriptionId?: never; payment?: never }
  )

/** Durable cancel/refund retry after a competing-subscription transaction rolls back. */
export const billingCompensation = pgTable(
  'billing_compensation',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    key: text('key').notNull().unique(),
    payload: jsonb('payload').$type<SubscriptionCompensationPayload>().notNull(),
    status: text('status', { enum: ['pending', 'processing', 'completed'] })
      .notNull()
      .default('pending'),
    cancelCompleted: boolean('cancel_completed').notNull().default(false),
    providerRefundId: text('provider_refund_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('billing_compensation_attempts_nonnegative', sql`${t.attempts} >= 0`),
    index('billing_compensation_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('billing_compensation_retry_idx').on(t.status, t.leaseUntil),
  ],
)
export type BillingCompensation = typeof billingCompensation.$inferSelect
