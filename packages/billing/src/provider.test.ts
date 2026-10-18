import { describe, expectTypeOf, it } from 'vitest'
import type {
  CheckoutMetadata,
  NormalizedEvent,
  PaymentProvider,
  PaymentSnapshot,
  RefundInput,
  SubscriptionSnapshot,
  VerifiedWebhook,
} from './provider.ts'

// tsc validates negative examples as well as the narrowing used by webhook consumers.
function narrowEvent(event: NormalizedEvent) {
  switch (event.type) {
    case 'checkout.completed':
      expectTypeOf(event.metadata).toEqualTypeOf<CheckoutMetadata>()
      if (event.mode === 'subscription')
        expectTypeOf(event.providerSubscriptionId).toEqualTypeOf<string>()
      else expectTypeOf(event.providerOrderId).toEqualTypeOf<string>()
      break
    case 'subscription.activated':
    case 'subscription.updated':
      expectTypeOf(event.subscription).toEqualTypeOf<SubscriptionSnapshot>()
      break
    case 'payment.succeeded':
      expectTypeOf(event.payment).toEqualTypeOf<PaymentSnapshot>()
      if (event.payment.kind === 'one_time') {
        expectTypeOf(event.payment.providerOrderId).toEqualTypeOf<string>()
        expectTypeOf(event.payment.period).toEqualTypeOf<null>()
      } else {
        expectTypeOf(event.payment.providerSubscriptionId).toEqualTypeOf<string>()
        expectTypeOf(event.payment.period).toEqualTypeOf<{ start: Date; end: Date }>()
      }
      break
    case 'payment.refunded':
      expectTypeOf(event.providerRefundId).toEqualTypeOf<string>()
      expectTypeOf(event.refundedAmount).toEqualTypeOf<number | null>()
      break
    case 'subscription.renewed':
    case 'subscription.past_due':
    case 'subscription.canceled':
      expectTypeOf(event.providerSubscriptionId).toEqualTypeOf<string>()
      break
    case 'payment.disputed':
      expectTypeOf(event.providerDisputeId).toEqualTypeOf<string>()
      break
    default:
      expectTypeOf(event).toEqualTypeOf<never>()
  }
}

function invalidContracts() {
  // @ts-expect-error Required idempotency key prevents unsafe retry contracts.
  const refund: RefundInput = { providerPaymentId: 'pi_test', kind: 'initial', currency: 'usd' }
  // @ts-expect-error A payment must identify a subscription or order according to kind.
  const orphan: PaymentSnapshot = {
    kind: 'one_time',
    providerPaymentId: 'capture',
    providerCustomerId: null,
    amount: 100,
    currency: 'usd',
    paidAt: new Date(),
    refundedAmount: 0,
    status: 'succeeded',
    metadata: null,
    raw: null,
  }
  // @ts-expect-error Later refunds cannot be located by metadata instead of the payment object ID.
  const event: NormalizedEvent = {
    type: 'payment.refunded',
    provider: 'stripe',
    occurredAt: new Date(),
    raw: null,
  }
  return [refund, orphan, event]
}

// Keep compile-time consumer examples without running fake payment operations.
void narrowEvent
void invalidContracts

describe('payment provider contract types', () => {
  it('exposes verification, repair, reconciliation and price synchronization', () => {
    expectTypeOf<PaymentProvider['verifyWebhook']>().returns.toEqualTypeOf<
      Promise<VerifiedWebhook>
    >()
    expectTypeOf<PaymentProvider['getSubscription']>().returns.toEqualTypeOf<
      Promise<SubscriptionSnapshot>
    >()
    expectTypeOf<PaymentProvider['getPayment']>().returns.toEqualTypeOf<Promise<PaymentSnapshot>>()
    expectTypeOf<PaymentProvider['syncPlan']>().returns.toEqualTypeOf<
      Promise<{ providerPriceId: string }>
    >()
    expectTypeOf<NonNullable<PaymentProvider['refund']>>().parameter(0).toEqualTypeOf<RefundInput>()
  })
})
