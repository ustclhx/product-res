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
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { organization } from './tenancy.ts'

export type PaymentProviderId = 'stripe' | 'paypal' | 'creem' | 'paddle' | 'polar'
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'paused'
export type PaymentKind = 'initial' | 'renewal' | 'adjustment' | 'one_time'
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export interface PlanFeatures {
  models: string[]
  maxConcurrentTasks: number
  maxSeats: number
  storageGb: number
  publicApi: boolean
  priorityQueue: boolean
  watermark: boolean
}

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}

export const plan = pgTable(
  'plan',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    type: text('type', { enum: ['subscription', 'credit_pack'] }).notNull(),
    credits: integer('credits').notNull(),
    creditExpiryDays: integer('credit_expiry_days'),
    rollover: boolean('rollover').notNull().default(false),
    features: jsonb('features').$type<PlanFeatures>().notNull(),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check('plan_credits_nonnegative', sql`${t.credits} >= 0`),
    check('plan_credit_expiry_days_positive', sql`${t.creditExpiryDays} > 0`),
  ],
)

export const planPrice = pgTable(
  'plan_price',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plan.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerPriceId: text('provider_price_id').notNull(),
    interval: text('interval', { enum: ['month', 'year'] }),
    // All monetary values are integers in the currency's smallest unit.
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('plan_price_provider_price_unique').on(t.provider, t.providerPriceId),
    check('plan_price_amount_nonnegative', sql`${t.amount} >= 0`),
  ],
)

export const billingCustomer = pgTable(
  'billing_customer',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerCustomerId: text('provider_customer_id'),
    ...timestamps,
  },
  (t) => [
    unique('billing_customer_workspace_provider_unique').on(t.workspaceId, t.provider),
    index('billing_customer_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
  ],
)

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plan.id, { onDelete: 'restrict' }),
    planPriceId: uuid('plan_price_id')
      .notNull()
      .references(() => planPrice.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    status: text('status').$type<SubscriptionStatus>().notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    pastDueSince: timestamp('past_due_since', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    raw: jsonb('raw').$type<JsonValue>(),
    ...timestamps,
  },
  (t) => [
    unique('subscription_provider_subscription_unique').on(t.provider, t.providerSubscriptionId),
    uniqueIndex('subscription_one_renewing_per_workspace')
      .on(t.workspaceId)
      .where(
        sql`${t.status} in ('trialing', 'active', 'past_due', 'paused') and ${t.cancelAtPeriodEnd} = false`,
      ),
    index('subscription_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
  ],
)

export const purchase = pgTable(
  'purchase',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plan.id, { onDelete: 'restrict' }),
    planPriceId: uuid('plan_price_id')
      .notNull()
      .references(() => planPrice.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    status: text('status', { enum: ['pending', 'paid', 'refunded', 'failed'] })
      .notNull()
      .default('pending'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    raw: jsonb('raw').$type<JsonValue>(),
    ...timestamps,
  },
  (t) => [
    unique('purchase_provider_order_unique').on(t.provider, t.providerOrderId),
    index('purchase_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    check('purchase_amount_nonnegative', sql`${t.amount} >= 0`),
  ],
)

export const payment = pgTable(
  'payment',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscription.id, {
      onDelete: 'restrict',
    }),
    purchaseId: uuid('purchase_id').references(() => purchase.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<PaymentKind>().notNull(),
    // Immutable purchase provenance, retained when the subscription later changes.
    planPriceId: uuid('plan_price_id').references(() => planPrice.id, { onDelete: 'restrict' }),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['succeeded', 'refunded', 'partially_refunded', 'disputed'] })
      .notNull()
      .default('succeeded'),
    refundedAmount: integer('refunded_amount').notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('payment_provider_payment_unique').on(t.provider, t.providerPaymentId),
    index('payment_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    check('payment_amount_nonnegative', sql`${t.amount} >= 0`),
    check(
      'payment_period_pair',
      sql`(${t.periodStart} is null and ${t.periodEnd} is null) or (${t.periodStart} is not null and ${t.periodEnd} is not null and ${t.periodEnd} > ${t.periodStart})`,
    ),
    check(
      'payment_refunded_amount_bounds',
      sql`${t.refundedAmount} >= 0 and ${t.refundedAmount} <= ${t.amount}`,
    ),
    check(
      'payment_kind_reference',
      sql`(${t.kind} = 'one_time' and ${t.purchaseId} is not null and ${t.subscriptionId} is null) or (${t.kind} in ('initial', 'renewal', 'adjustment') and ${t.subscriptionId} is not null and ${t.purchaseId} is null)`,
    ),
  ],
)

/** One verified refund identity across webhook deliveries and review retries. */
export const paymentRefund = pgTable(
  'payment_refund',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payment.id, { onDelete: 'restrict' }),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerRefundId: text('provider_refund_id').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('payment_refund_provider_refund_unique').on(t.provider, t.providerRefundId),
    index('payment_refund_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    check('payment_refund_amount_positive', sql`${t.amount} > 0`),
  ],
)

export const refundRequest = pgTable(
  'refund_request',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payment.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    contactEmail: text('contact_email'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'refunded'] })
      .notNull()
      .default('pending'),
    requestedAmount: integer('requested_amount'),
    approvedAmount: integer('approved_amount'),
    providerRefundId: text('provider_refund_id'),
    reviewerId: uuid('reviewer_id').references(() => user.id, { onDelete: 'restrict' }),
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('refund_request_one_pending_per_payment')
      .on(t.paymentId)
      .where(sql`${t.status} = 'pending'`),
    index('refund_request_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    check(
      'refund_request_amounts_positive',
      sql`${t.requestedAmount} > 0 and ${t.approvedAmount} > 0`,
    ),
  ],
)

export const webhookEvent = pgTable(
  'webhook_event',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    provider: text('provider').$type<PaymentProviderId>().notNull(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    status: text('status', { enum: ['received', 'processed', 'failed', 'ignored'] })
      .notNull()
      .default('received'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('webhook_event_provider_event_unique').on(t.provider, t.providerEventId),
    check('webhook_event_attempts_nonnegative', sql`${t.attempts} >= 0`),
  ],
)

export type Plan = typeof plan.$inferSelect
export type PlanPrice = typeof planPrice.$inferSelect
export type BillingCustomer = typeof billingCustomer.$inferSelect
export type Subscription = typeof subscription.$inferSelect
export type Purchase = typeof purchase.$inferSelect
export type Payment = typeof payment.$inferSelect
export type PaymentRefund = typeof paymentRefund.$inferSelect
export type RefundRequest = typeof refundRequest.$inferSelect
export type WebhookEvent = typeof webhookEvent.$inferSelect
