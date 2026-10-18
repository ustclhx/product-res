import { Button } from '@product-res/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getCustomerUsage } from '../../../features/billing/customer.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug/usage')({
  beforeLoad: () => {
    if (!templateConfig.credits.enabled) throw featureNotFound()
  },
  loader: ({ params }) => getCustomerUsage({ data: { slug: params.slug } }),
  staleTime: 0,
  component: UsagePage,
})
function UsagePage() {
  const initial = Route.useLoaderData()
  const { slug } = Route.useParams()
  const [page, setPage] = useState(initial)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => setReady(true), [])
  useEffect(() => setPage(initial), [initial])
  async function next(kind: 'ledger' | 'batches') {
    const cursor = kind === 'ledger' ? page.ledger.nextCursor : page.batches?.nextCursor
    if (!cursor) return
    setBusy(true)
    setMessage('')
    try {
      const result = await getCustomerUsage({ data: { slug, kind, cursor, limit: 25 } })
      setPage((old) =>
        kind === 'ledger'
          ? { ...old, ledger: result.ledger }
          : { ...old, batches: result.batches, balance: result.balance },
      )
    } catch {
      setMessage('Unable to load usage. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-6">
      <h2 className="text-2xl font-semibold">Credit usage</h2>
      {page.balance ? (
        <p>
          Available: {page.balance.available} · Held: {page.balance.held} · Debt:{' '}
          {page.balance.debt}
        </p>
      ) : (
        <p>Your own credit activity is shown below.</p>
      )}
      {page.batches && (
        <section className="grid gap-3">
          <h3 className="font-semibold">Credit batches</h3>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Granted</th>
                <th>Remaining</th>
                <th>Status</th>
                <th>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {page.batches.items.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.source}</td>
                  <td>{batch.amount}</td>
                  <td>{batch.remaining}</td>
                  <td>{batch.status}</td>
                  <td>
                    {batch.expiresAt
                      ? new Date(batch.expiresAt).toLocaleDateString('en-US', { timeZone: 'UTC' })
                      : 'No expiry'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.batches.items.length === 0 && <p>No credit batches yet.</p>}
          <Button
            disabled={!ready || busy || !page.batches.nextCursor}
            onClick={() => void next('batches')}
          >
            Older batches
          </Button>
        </section>
      )}
      <section className="grid gap-3">
        <h3 className="font-semibold">Credit ledger</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Credits</th>
              <th>Reference</th>
              <th>Batch</th>
            </tr>
          </thead>
          <tbody>
            {page.ledger.items.map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.createdAt).toLocaleString('en-US', { timeZone: 'UTC' })}</td>
                <td>{item.type}</td>
                <td>
                  {item.delta > 0 ? '+' : ''}
                  {item.delta}
                </td>
                <td>
                  {item.refType}
                  {item.refId ? ` · ${item.refId}` : ''}
                </td>
                <td>{item.grantId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.ledger.items.length === 0 && <p>No credit activity yet.</p>}
        <Button
          disabled={!ready || busy || !page.ledger.nextCursor}
          onClick={() => void next('ledger')}
        >
          Older activity
        </Button>
      </section>
      {message && <p role="status">{message}</p>}
    </div>
  )
}
