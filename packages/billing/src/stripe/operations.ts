import type { PlanPrice } from '@product-res/db/schema'
import Stripe from 'stripe'
import type { CheckoutInput, PaymentProvider, PlanSyncInput, RefundInput } from '../provider.ts'
import { parseStripeMetadata } from './metadata.ts'

export type StripeOperations = Required<
  Pick<
    PaymentProvider,
    | 'createCheckout'
    | 'getPortalUrl'
    | 'cancelSubscription'
    | 'resumeSubscription'
    | 'changePlan'
    | 'refund'
    | 'syncPlan'
  >
>

function priceId(price: PlanPrice): string {
  if (price.provider !== 'stripe' || !price.active || !price.providerPriceId.startsWith('price_')) {
    throw new Error('Expected an active Stripe price mapping')
  }
  return price.providerPriceId
}

function requestOptions(idempotencyKey: string): Stripe.RequestOptions {
  if (!idempotencyKey.trim() || idempotencyKey.length > 255) {
    throw new Error('A nonempty stable idempotency key of at most 255 characters is required')
  }
  return { idempotencyKey }
}

export async function createStripeCheckout(stripe: Stripe, input: CheckoutInput) {
  const options = requestOptions(input.idempotencyKey)
  const metadata = parseStripeMetadata({
    workspaceId: input.workspaceId,
    planPriceId: input.price.id,
    userId: input.userId,
  })
  if (!metadata) throw new Error('Checkout source metadata must contain UUIDs')
  if ((input.mode === 'subscription') !== (input.price.interval !== null)) {
    throw new Error('Checkout mode must match the price interval')
  }
  const session = await stripe.checkout.sessions.create(
    {
      mode: input.mode === 'one_time' ? 'payment' : 'subscription',
      // 模板不由 Stripe 代销，避免账户默认的 Managed Payments 改变结算模式。
      managed_payments: { enabled: false },
      line_items: [{ price: priceId(input.price), quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.providerCustomerId
        ? { customer: input.providerCustomerId }
        : {
            customer_email: input.customerEmail,
            ...(input.mode === 'one_time' ? { customer_creation: 'always' as const } : {}),
          }),
      metadata: { ...metadata },
      ...(input.mode === 'subscription'
        ? { subscription_data: { metadata: { ...metadata } } }
        : { payment_intent_data: { metadata: { ...metadata } } }),
    },
    options,
  )
  if (!session.url) throw new Error('Stripe hosted Checkout session has no URL')
  return { url: session.url, providerRef: session.id }
}

function objectId(object: string | { id: string }): string {
  return typeof object === 'string' ? object : object.id
}

async function releaseSchedule(stripe: Stripe, subscription: Stripe.Subscription) {
  if (subscription.schedule) {
    // Cancellation and an immediate change supersede a pending downgrade.
    await stripe.subscriptionSchedules.release(objectId(subscription.schedule))
  }
}

type Phase = Stripe.SubscriptionScheduleUpdateParams.Phase

function phaseDiscount(discount: Stripe.SubscriptionSchedule.Phase.Discount) {
  if (discount.discount) return { discount: objectId(discount.discount) }
  if (discount.promotion_code) return { promotion_code: objectId(discount.promotion_code) }
  if (discount.coupon) return { coupon: objectId(discount.coupon) }
  throw new Error('Stripe schedule discount has no reference')
}

/** Stripe unsets omitted phase settings on update; explicitly preserve existing billing terms. */
function phaseSettings(phase: Stripe.SubscriptionSchedule.Phase): Omit<Phase, 'items'> {
  const invoice = phase.invoice_settings
  return {
    ...(phase.application_fee_percent === null
      ? {}
      : { application_fee_percent: phase.application_fee_percent }),
    ...(phase.automatic_tax
      ? {
          automatic_tax: {
            enabled: phase.automatic_tax.enabled,
            ...(phase.automatic_tax.liability
              ? {
                  liability: {
                    type: phase.automatic_tax.liability.type,
                    ...(phase.automatic_tax.liability.account
                      ? { account: objectId(phase.automatic_tax.liability.account) }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(phase.billing_cycle_anchor ? { billing_cycle_anchor: phase.billing_cycle_anchor } : {}),
    ...(phase.billing_thresholds
      ? {
          billing_thresholds: {
            ...(phase.billing_thresholds.amount_gte === null
              ? {}
              : { amount_gte: phase.billing_thresholds.amount_gte }),
            ...(phase.billing_thresholds.reset_billing_cycle_anchor === null
              ? {}
              : {
                  reset_billing_cycle_anchor: phase.billing_thresholds.reset_billing_cycle_anchor,
                }),
          },
        }
      : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    currency: phase.currency,
    ...(phase.default_payment_method
      ? { default_payment_method: objectId(phase.default_payment_method) }
      : {}),
    default_tax_rates: phase.default_tax_rates?.map((rate) => rate.id) ?? [],
    ...(phase.description ? { description: phase.description } : {}),
    discounts: phase.discounts.map(phaseDiscount),
    ...(invoice
      ? {
          invoice_settings: {
            ...(invoice.account_tax_ids
              ? { account_tax_ids: invoice.account_tax_ids.map(objectId) }
              : {}),
            ...(invoice.custom_fields ? { custom_fields: invoice.custom_fields } : {}),
            ...(invoice.days_until_due === null ? {} : { days_until_due: invoice.days_until_due }),
            ...(invoice.description ? { description: invoice.description } : {}),
            ...(invoice.footer ? { footer: invoice.footer } : {}),
            ...(invoice.issuer
              ? {
                  issuer: {
                    type: invoice.issuer.type,
                    ...(invoice.issuer.account
                      ? { account: objectId(invoice.issuer.account) }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(phase.on_behalf_of ? { on_behalf_of: objectId(phase.on_behalf_of) } : {}),
    ...(phase.transfer_data
      ? {
          transfer_data: {
            destination: objectId(phase.transfer_data.destination),
            ...(phase.transfer_data.amount_percent === null
              ? {}
              : { amount_percent: phase.transfer_data.amount_percent }),
          },
        }
      : {}),
  }
}

export async function cancelStripeSubscription(
  stripe: Stripe,
  subId: string,
  opts: { atPeriodEnd: boolean },
): Promise<void> {
  const subscription = await stripe.subscriptions.retrieve(subId)
  await releaseSchedule(stripe, subscription)
  if (opts.atPeriodEnd) await stripe.subscriptions.update(subId, { cancel_at_period_end: true })
  else await stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false })
}

/** Restore a period-end cancellation; an already canceled subscription cannot be restored. */
export async function resumeStripeSubscription(stripe: Stripe, subId: string): Promise<void> {
  await stripe.subscriptions.update(subId, { cancel_at_period_end: false })
}

export async function changeStripePlan(
  stripe: Stripe,
  subId: string,
  newPrice: PlanPrice,
  opts: { atPeriodEnd: boolean },
): Promise<void> {
  const target = priceId(newPrice)
  if (!newPrice.interval) throw new Error('Subscription changes require a recurring price')
  const subscription = await stripe.subscriptions.retrieve(subId)
  const item = subscription.items.data[0]
  if (!item || subscription.items.has_more || subscription.items.data.length !== 1) {
    throw new Error('Plan changes require a single subscription item')
  }
  if (subscription.pending_update) throw new Error('Subscription has a pending payment update')
  if (subscription.cancel_at_period_end)
    throw new Error('Resume the subscription before changing plan')
  const metadata = { ...subscription.metadata, planPriceId: newPrice.id }
  if (!opts.atPeriodEnd) {
    await releaseSchedule(stripe, subscription)
    await stripe.subscriptions.update(subId, {
      items: [{ id: item.id, price: target, quantity: item.quantity ?? 1 }],
      metadata,
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
    // Credit grants are exclusively the verified payment-event consumer's responsibility.
    return
  }
  const schedule = subscription.schedule
    ? await stripe.subscriptionSchedules.retrieve(objectId(subscription.schedule))
    : // SDK request keys cover network retries. A later cancel/resume/downgrade must
      // create a fresh schedule rather than replaying a previously released one.
      await stripe.subscriptionSchedules.create({ from_subscription: subId })
  if (schedule.phases.length > 1 && schedule.metadata?.saasManaged !== 'plan_change') {
    throw new Error('Cannot replace an externally managed subscription schedule')
  }
  const current = schedule.phases.find(
    (phase) => phase.start_date === schedule.current_phase?.start_date,
  )
  if (!current) throw new Error('Stripe schedule has no current phase')
  const common = phaseSettings(current)
  const phaseItem = current.items[0]
  if (!phaseItem || current.items.length !== 1) throw new Error('Schedule must have a single item')
  const itemSettings = {
    quantity: item.quantity ?? 1,
    metadata: { ...phaseItem.metadata },
    discounts: phaseItem.discounts.map(phaseDiscount),
    tax_rates: phaseItem.tax_rates?.map((rate) => rate.id) ?? [],
    ...(phaseItem.billing_thresholds?.usage_gte == null
      ? {}
      : {
          billing_thresholds: { usage_gte: phaseItem.billing_thresholds.usage_gte },
        }),
  }
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    metadata: { saasManaged: 'plan_change' },
    proration_behavior: 'none',
    phases: [
      {
        ...common,
        start_date: current.start_date,
        end_date: item.current_period_end,
        items: [{ ...itemSettings, price: item.price.id }],
        add_invoice_items: current.add_invoice_items.map((invoiceItem) => ({
          price: objectId(invoiceItem.price),
          ...(invoiceItem.quantity === null ? {} : { quantity: invoiceItem.quantity }),
          ...(invoiceItem.discountable === null ? {} : { discountable: invoiceItem.discountable }),
          discounts: invoiceItem.discounts.map(phaseDiscount),
          metadata: { ...invoiceItem.metadata },
          period: invoiceItem.period,
          tax_rates: invoiceItem.tax_rates?.map((rate) => rate.id) ?? [],
        })),
        metadata: { ...subscription.metadata },
        proration_behavior: 'none',
        ...(current.trial_end ? { trial_end: current.trial_end } : {}),
        ...(current.trial ? { trial: true } : {}),
      },
      {
        ...common,
        start_date: item.current_period_end,
        duration: { interval: newPrice.interval, interval_count: 1 },
        items: [{ ...itemSettings, price: target }],
        metadata,
        proration_behavior: 'none',
      },
    ],
  })
}

export async function refundStripePayment(stripe: Stripe, input: RefundInput) {
  const options = requestOptions(input.idempotencyKey)
  if (input.amount !== undefined && (!Number.isSafeInteger(input.amount) || input.amount <= 0)) {
    throw new Error('Refund amount must be a positive integer in the smallest currency unit')
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: input.providerPaymentId,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
    },
    options,
  )
  return { providerRefundId: refund.id }
}

export async function syncStripePlan(stripe: Stripe, input: PlanSyncInput) {
  const options = requestOptions(input.idempotencyKey)
  if ((input.plan.type === 'subscription') !== (input.price.interval !== null)) {
    throw new Error('Plan type must match the price interval')
  }
  if (input.providerPriceId) {
    const existing = await stripe.prices.retrieve(input.providerPriceId)
    if (
      existing.unit_amount !== input.price.amount ||
      existing.currency !== input.price.currency.toLowerCase() ||
      (existing.recurring?.interval ?? null) !== input.price.interval ||
      (existing.recurring?.interval_count ?? 1) !== 1 ||
      existing.metadata.planId !== input.plan.id ||
      existing.metadata.planPriceId !== input.price.id
    ) {
      throw new Error('Immutable Stripe price mapping does not match the local price')
    }
    return { providerPriceId: existing.id }
  }
  const productId = `product_res_plan_${input.plan.id.replaceAll('-', '')}`
  try {
    await stripe.products.retrieve(productId)
  } catch (error) {
    if (
      !(error instanceof Stripe.errors.StripeInvalidRequestError) ||
      error.code !== 'resource_missing'
    ) {
      throw error
    }
    await stripe.products.create(
      {
        id: productId,
        name: input.plan.name,
        metadata: { planId: input.plan.id },
      },
      { idempotencyKey: `saas:product:${input.plan.id}` },
    )
  }
  const price = await stripe.prices.create(
    {
      product: productId,
      currency: input.price.currency.toLowerCase(),
      unit_amount: input.price.amount,
      active: input.plan.active && input.price.active,
      ...(input.price.interval ? { recurring: { interval: input.price.interval } } : {}),
      metadata: { planId: input.plan.id, planPriceId: input.price.id },
    },
    options,
  )
  return { providerPriceId: price.id }
}

/** Compose these operations with retrieval and verification in the next adapter slice. */
export function createStripeOperations(stripe: Stripe): StripeOperations {
  return {
    createCheckout: (input) => createStripeCheckout(stripe, input),
    getPortalUrl: async (customerId, returnUrl) =>
      (await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }))
        .url,
    cancelSubscription: (subId, opts) => cancelStripeSubscription(stripe, subId, opts),
    resumeSubscription: (subId) => resumeStripeSubscription(stripe, subId),
    changePlan: (subId, newPrice, opts) => changeStripePlan(stripe, subId, newPrice, opts),
    refund: (input) => refundStripePayment(stripe, input),
    syncPlan: (input) => syncStripePlan(stripe, input),
  }
}
