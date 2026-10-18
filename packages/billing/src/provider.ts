import type {
  JsonValue,
  PaymentKind,
  PaymentProviderId,
  Plan,
  PlanPrice,
  SubscriptionStatus,
} from '@product-res/db/schema'

/** Invalid delivery authentication; transport/enrichment failures remain retryable errors. */
export class WebhookVerificationError extends Error {}

export type { PaymentProviderId } from '@product-res/db/schema'

export interface ProviderCapabilities {
  portal: boolean
  changePlan: boolean
  refundsViaApi: boolean
  merchantOfRecord: boolean
}

/** Metadata is trusted only when establishing the initial local association. */
export interface CheckoutMetadata {
  workspaceId: string
  planPriceId: string
  userId: string
}

export interface CheckoutInput {
  workspaceId: string
  userId: string
  price: PlanPrice
  mode: 'subscription' | 'one_time'
  successUrl: string
  cancelUrl: string
  customerEmail: string
  providerCustomerId?: string
  idempotencyKey: string
}

export interface SubscriptionSnapshot {
  providerSubscriptionId: string
  providerCustomerId: string | null
  providerPriceId: string
  status: SubscriptionStatus
  /** Preserve the actual remote status for reconciliation (e.g. PayPal SUSPENDED). */
  remoteStatus: string
  /** Unpaid remote subscriptions may have no service period. */
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
  trialEnd: Date | null
  pastDueSince: Date | null
  metadata: CheckoutMetadata | null
  raw: JsonValue
}

export interface OrderSnapshot {
  providerOrderId: string
  providerCustomerId: string | null
  providerPriceId: string | null
  status: 'pending' | 'paid' | 'refunded' | 'failed'
  amount: number
  currency: string
  metadata: CheckoutMetadata | null
  raw: JsonValue
}

/** Stripe PaymentIntent, PayPal Capture (one_time) or Sale (subscription). */
export interface PaymentReference {
  providerPaymentId: string
  kind: PaymentKind
}

export type PaymentAssociation =
  | { kind: 'one_time'; providerOrderId: string; providerSubscriptionId?: never }
  | {
      kind: 'initial' | 'renewal' | 'adjustment'
      providerSubscriptionId: string
      providerOrderId?: never
    }

export type PaymentSnapshot = (
  | (Extract<PaymentAssociation, { kind: 'one_time' }> & { period: null })
  | (Extract<PaymentAssociation, { kind: 'initial' | 'renewal' | 'adjustment' }> & {
      period: { start: Date; end: Date }
    })
) & {
  providerPaymentId: string
  /** Actual historical price, independent of the current mutable subscription. */
  providerPriceId?: string | null
  providerCustomerId: string | null
  amount: number
  currency: string
  paidAt: Date
  /** null means the provider does not expose a cumulative total; preserve local refunds. */
  refundedAmount: number | null
  status: 'succeeded' | 'refunded' | 'partially_refunded' | 'disputed'
  metadata: CheckoutMetadata | null
  raw: JsonValue
}

interface EventBase {
  provider: PaymentProviderId
  occurredAt: Date
  raw: JsonValue
}

/** Every delivery is deduplicated as a unit; its typed events are processed in one transaction. */
export type NormalizedEvent = EventBase &
  (
    | ({
        type: 'checkout.completed'
        providerCheckoutId: string
        providerCustomerId: string | null
        metadata: CheckoutMetadata
      } & (
        | { mode: 'subscription'; providerSubscriptionId: string; providerOrderId?: never }
        | { mode: 'one_time'; providerOrderId: string; providerSubscriptionId?: never }
      ))
    | {
        type: 'subscription.activated'
        subscription: SubscriptionSnapshot
      }
    | {
        type: 'subscription.updated'
        subscription: SubscriptionSnapshot
      }
    | {
        type: 'subscription.renewed'
        providerSubscriptionId: string
        providerPaymentId: string
        periodStart: Date
        periodEnd: Date
      }
    | {
        type: 'subscription.past_due'
        providerSubscriptionId: string
        pastDueSince: Date
        status: 'past_due' | 'paused'
      }
    | {
        type: 'subscription.canceled'
        providerSubscriptionId: string
        status: 'canceled' | 'expired'
        canceledAt: Date
        currentPeriodEnd: Date | null
      }
    | {
        type: 'payment.succeeded'
        payment: PaymentSnapshot
      }
    | {
        type: 'payment.refunded'
        providerPaymentId: string
        providerRefundId: string
        amount: number
        currency: string
        /** Cumulative refunded amount, not this refund's delta. */
        refundedAmount: number | null
      }
    | {
        type: 'payment.disputed'
        providerPaymentId: string
        providerDisputeId: string
        amount: number
        currency: string
      }
  )

export interface VerifiedWebhook {
  providerEventId: string
  /** Original remote event name, including deliveries with zero supported internal events. */
  type: string
  events: NormalizedEvent[]
}

export interface RefundInput extends PaymentReference {
  /** Stable request ID reused on retries and concurrent review attempts. */
  idempotencyKey: string
  /** Smallest currency unit; omitted means refund the remaining full amount. */
  amount?: number
  currency: string
}

export interface PlanSyncInput {
  plan: Pick<Plan, 'id' | 'key' | 'name' | 'type' | 'active'>
  price: Pick<PlanPrice, 'id' | 'interval' | 'amount' | 'currency' | 'active'>
  /** Existing mapping allows adapters to reuse immutable remote prices/plans. */
  providerPriceId?: string
  idempotencyKey: string
}

/** All platform access, including missing-association repair and reconciliation, stays here. */
export interface PaymentProvider {
  readonly id: PaymentProviderId
  readonly capabilities: ProviderCapabilities
  createCheckout(input: CheckoutInput): Promise<{ url: string; providerRef: string }>
  /** PayPal capture advances remote state; only verified payment events grant credits. */
  confirmCheckout?(providerRef: string, options: { idempotencyKey: string }): Promise<void>
  verifyWebhook(req: Request, rawBody: string): Promise<VerifiedWebhook>
  cancelSubscription(subId: string, opts: { atPeriodEnd: boolean }): Promise<void>
  resumeSubscription?(subId: string): Promise<void>
  changePlan?(subId: string, newPrice: PlanPrice, opts: { atPeriodEnd: boolean }): Promise<void>
  getPortalUrl?(customerId: string, returnUrl: string): Promise<string>
  refund?(input: RefundInput): Promise<{ providerRefundId: string }>
  getSubscription(subId: string): Promise<SubscriptionSnapshot>
  getOrder(orderId: string): Promise<OrderSnapshot>
  getPayment(payment: PaymentReference): Promise<PaymentSnapshot>
  syncPlan(input: PlanSyncInput): Promise<{ providerPriceId: string }>
}
