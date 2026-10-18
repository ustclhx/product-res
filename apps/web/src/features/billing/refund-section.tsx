import { Button } from '@product-res/ui'
import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { type getCustomerRefunds, requestCustomerRefund } from './refund.functions.ts'

export function RefundSection({
  slug,
  page,
  readOnly,
  pendingPayments,
}: {
  slug: string
  page: Awaited<ReturnType<typeof getCustomerRefunds>>
  readOnly: boolean
  pendingPayments: string[]
}) {
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [paymentId, setPaymentId] = useState('')
  const [reason, setReason] = useState('')
  const [contactEmail, setContactEmail] = useState(page?.contactEmail ?? '')
  const [message, setMessage] = useState('')
  const router = useRouter()
  useEffect(() => setReady(true), [])
  if (!page) return null
  const payments = page.payments.filter((p) => !pendingPayments.includes(p.id))
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await requestCustomerRefund({
        data: { slug, paymentId, reason, contactEmail },
      })
      setMessage(
        result.ok
          ? 'Refund request submitted. The decision will be sent to your contact email.'
          : result.error === 'REFUND_ALREADY_PENDING'
            ? m.refund_error_pending()
            : m.refund_error_reload(),
      )
      if (result.ok) {
        setPaymentId('')
        setReason('')
        await router.invalidate()
      }
    } catch {
      setMessage(m.refund_error_unknown())
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-3 rounded-xl border p-6">
      <h3 className="font-semibold">Request a refund</h3>
      <p>
        Payments within {page.windowDays} days can be reviewed. Refunds require approval; canceling
        or deleting an account does not automatically refund payments.
      </p>
      <p>
        The contact email is retained so you can receive the decision after deleting your account.
        It is cleared 30 days after a final decision.
      </p>
      {payments.length > 0 ? (
        <form onSubmit={(e) => void submit(e)} aria-label="Request a refund" className="grid gap-3">
          <label>
            Payment{' '}
            <select
              required
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
              disabled={readOnly || busy}
            >
              <option value="">Choose a payment</option>
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.provider} ·{' '}
                  {new Date(p.paidAt).toLocaleDateString('en-US', { timeZone: 'UTC' })} ·{' '}
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    p.remainingRefundable / 100,
                  )}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason{' '}
            <textarea
              required
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={readOnly || busy}
            />
          </label>
          <label>
            Contact email{' '}
            <input
              required
              type="email"
              maxLength={254}
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              disabled={readOnly || busy}
            />
          </label>
          <Button
            type="submit"
            disabled={!ready || busy || readOnly || !paymentId || !reason.trim() || !contactEmail}
          >
            Submit refund request
          </Button>
        </form>
      ) : (
        <p>No eligible payments without a pending request.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
