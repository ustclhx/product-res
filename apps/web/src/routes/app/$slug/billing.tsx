import { Button } from '@product-res/ui'
import {
  createFileRoute,
  notFound as featureNotFound,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
  checkoutCustomer,
  getCustomerBilling,
  manageCustomerSubscription,
} from '../../../features/billing/customer.functions.ts'
import { getCustomerRefunds } from '../../../features/billing/refund.functions.ts'
import { RefundSection } from '../../../features/billing/refund-section.tsx'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug/billing')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  loader: async ({ params }) => {
    const [billing, refunds] = await Promise.all([
      getCustomerBilling({ data: { slug: params.slug } }),
      getCustomerRefunds({ data: { slug: params.slug } }),
    ])
    return { ...billing, refundView: refunds }
  },
  staleTime: 0,
  component: BillingPage,
})
const money = (amount: number, currency: string) =>
  currency.toUpperCase() === 'USD'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100)
    : 'Amount unavailable'
const date = (value: Date | null) =>
  value ? new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC' }) : 'Pending'
function BillingPage() {
  const page = Route.useLoaderData()
  const { slug } = Route.useParams()
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState(
    page.catalog.providers.find((p) => p.available)?.id ?? page.catalog.providers[0]?.id ?? '',
  )
  const [priceId, setPriceId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const intent = useRef<{ key: string; uuid: string } | null>(null)
  useEffect(() => setReady(true), [])
  const owner = page.role === 'owner'
  const disabled = !ready || busy || page.readOnly || !owner
  const renewing = page.subscriptions.find(
    (sub) =>
      !sub.cancelAtPeriodEnd && ['active', 'trialing', 'past_due', 'paused'].includes(sub.status),
  )
  const selected = page.catalog.prices.find((price) => price.id === priceId)
  const isSubscription =
    page.catalog.plans.find((plan) => plan.id === selected?.planId)?.type === 'subscription'
  const change = isSubscription && renewing?.provider === 'stripe' && provider === 'stripe'
  const replacement = isSubscription && !change ? renewing : undefined
  async function manage(subscriptionId: string, action: 'cancel' | 'resume' | 'portal' | 'change') {
    setBusy(true)
    setMessage('')
    try {
      const result = await manageCustomerSubscription({
        data: {
          slug,
          subscriptionId,
          action,
          ...(action === 'change' ? { planPriceId: priceId } : {}),
        },
      })
      if (!result.ok) {
        setMessage(errorMessage(result.error))
        return
      }
      if ('url' in result.result && result.result.url) {
        window.location.assign(result.result.url)
        return
      }
      setMessage(
        result.result.status === 'scheduled'
          ? 'Plan change scheduled for the end of your paid period.'
          : 'Subscription updated.',
      )
      await router.invalidate()
    } catch {
      setMessage('Unable to update billing. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  async function checkout() {
    if (change && renewing && 'id' in renewing && renewing.id) {
      await manage(renewing.id, 'change')
      return
    }
    if (!selected) return
    const key = `${slug}:${provider}:${priceId}:${replacement && 'id' in replacement ? replacement.id : ''}`
    if (intent.current?.key !== key) intent.current = { key, uuid: crypto.randomUUID() }
    setBusy(true)
    setMessage('')
    try {
      const result = await checkoutCustomer({
        data: {
          slug,
          provider: selected.provider,
          planPriceId: priceId,
          idempotencyKey: intent.current.uuid,
          ...(replacement && 'id' in replacement && replacement.id
            ? { confirmSwitch: confirmed, expectedOldSubscriptionId: replacement.id }
            : {}),
        },
      })
      if (result.ok) window.location.assign(result.result.url)
      else setMessage(errorMessage(result.error))
    } catch {
      setMessage('Unable to start checkout. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-6">
      <h2 className="text-2xl font-semibold">Billing</h2>
      <p>Current plan: {page.entitlements.key}</p>
      {page.credits && (
        <p>
          Available credits: {page.credits.available} · Held: {page.credits.held} · Debt:{' '}
          {page.credits.debt}
        </p>
      )}
      <Link to="/app/$slug/usage" params={{ slug }} className="underline">
        Credit balance and usage
      </Link>
      {page.subscriptions.filter(
        (sub) =>
          sub.currentPeriodEnd &&
          new Date(sub.currentPeriodEnd) > new Date() &&
          ['active', 'trialing', 'canceled', 'expired', 'past_due'].includes(sub.status),
      ).length > 1 && (
        <p>
          Paid subscription periods overlap. Your access uses the highest eligible plan; each paid
          subscription grants its own credits until its paid period ends.
        </p>
      )}
      {page.subscriptions.map((sub) => (
        <section key={sub.id} className="grid gap-3 rounded-xl border p-6">
          <h3 className="font-semibold">{sub.name}</h3>
          <p>
            {sub.provider} · {sub.status}
          </p>
          <p>
            {sub.cancelAtPeriodEnd ? 'Paid access ends' : 'Next billing'}:{' '}
            {date(sub.currentPeriodEnd)}
          </p>
          {owner && 'id' in sub && sub.id && (
            <div className="flex gap-3">
              <Button
                disabled={
                  disabled ||
                  !page.catalog.providers.some((p) => p.id === sub.provider && p.available)
                }
                onClick={() => void manage(sub.id, sub.cancelAtPeriodEnd ? 'resume' : 'cancel')}
              >
                {sub.cancelAtPeriodEnd ? 'Resume subscription' : 'Cancel at period end'}
              </Button>
              {sub.provider === 'stripe' && (
                <Button
                  disabled={
                    disabled ||
                    !page.catalog.providers.some((p) => p.id === 'stripe' && p.available)
                  }
                  onClick={() => void manage(sub.id, 'portal')}
                >
                  Open billing portal
                </Button>
              )}
            </div>
          )}
        </section>
      ))}
      {owner && (
        <section className="grid gap-3 rounded-xl border p-6">
          <h3 className="font-semibold">Choose a plan or credit pack</h3>
          <label>
            Payment method{' '}
            <select
              value={provider}
              disabled={disabled}
              onChange={(event) => {
                setProvider(event.target.value)
                setPriceId('')
                setConfirmed(false)
                intent.current = null
              }}
            >
              {page.catalog.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.id}
                  {p.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Plan{' '}
            <select
              value={priceId}
              disabled={disabled}
              onChange={(event) => {
                setPriceId(event.target.value)
                setConfirmed(false)
                intent.current = null
              }}
            >
              <option value="">Choose a plan</option>
              {page.catalog.prices
                .filter(
                  (price) =>
                    price.provider === provider &&
                    page.catalog.plans.some((plan) => plan.id === price.planId),
                )
                .map((price) => (
                  <option key={price.id} value={price.id} disabled={!price.available}>
                    {page.catalog.plans.find((plan) => plan.id === price.planId)?.name} ·{' '}
                    {money(price.amount, price.currency)}
                    {price.interval ? ` / ${price.interval}` : ''}
                    {price.available ? '' : ' · unavailable'}
                  </option>
                ))}
            </select>
          </label>
          {!page.catalog.providers.some((p) => p.available) && (
            <p>Payments are currently unavailable.</p>
          )}
          {replacement && (
            <label>
              <input
                type="checkbox"
                disabled={disabled}
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{' '}
              I agree to cancel renewal of my current subscription and pay for the new plan
              immediately. My old paid access lasts until {date(replacement.currentPeriodEnd)}; the
              paid periods may overlap.
            </label>
          )}
          <Button
            disabled={disabled || !selected?.available || Boolean(replacement && !confirmed)}
            onClick={() => void checkout()}
          >
            {change ? 'Change plan' : 'Continue to checkout'}
          </Button>
        </section>
      )}
      {message && <p role="status">{message}</p>}
      <RefundSection
        slug={slug}
        page={page.refundView}
        readOnly={page.readOnly}
        pendingPayments={page.refunds.filter((r) => r.status === 'pending').map((r) => r.paymentId)}
      />
      {owner && (
        <section className="grid gap-3">
          <h3 className="font-semibold">Payment history</h3>
          <p>Canceling a subscription does not automatically refund previous payments.</p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Provider</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {page.payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{date(payment.paidAt)}</td>
                  <td>{payment.provider}</td>
                  <td>{money(payment.amount, payment.currency)}</td>
                  <td>{payment.status}</td>
                  <td>{money(payment.refundedAmount, payment.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.payments.length === 0 && <p>No payments yet.</p>}
          <h3 className="font-semibold">Refund requests</h3>
          {page.refunds.map((refund) => (
            <p key={refund.id}>
              {date(refund.createdAt)} · {refund.status}
            </p>
          ))}
          {page.refunds.length === 0 && <p>No refund requests.</p>}
        </section>
      )}
    </div>
  )
}
function errorMessage(code: string) {
  if (code === 'WORKSPACE_READ_ONLY') return m.billing_error_readonly()
  if (code === 'BILLING_OWNER_REQUIRED') return m.billing_error_owner()
  if (code === 'BILLING_PROVIDER_DISABLED' || code === 'BILLING_PRICE_UNAVAILABLE')
    return m.billing_error_unavailable()
  if (code === 'BILLING_SUBSCRIPTION_CHANGED' || code === 'BILLING_SWITCH_CONFIRMATION_REQUIRED')
    return m.billing_error_changed()
  return m.billing_error_unknown()
}
