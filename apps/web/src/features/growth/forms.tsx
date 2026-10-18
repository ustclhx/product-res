import { Button, Input } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { useTurnstile } from '../auth/turnstile.tsx'
import { getGrowthFormOptions } from './growth.functions.ts'

/** 独立收集表单：首页只挂载组件，关闭功能时不请求公开配置或加载 Turnstile。 */
export function GrowthForm({ feature }: { feature: 'waitlist' | 'newsletter' }) {
  const [options, setOptions] = useState<{ siteKey: string | null } | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    getGrowthFormOptions({ data: feature })
      .then(setOptions)
      .catch(() => setMessage('This form is unavailable.'))
  }, [feature])
  return (
    <section className="mx-auto grid max-w-lg gap-4 px-6 py-8">
      <h2 className="text-xl font-semibold">
        {feature === 'waitlist' ? 'Join the waitlist' : 'Subscribe to our newsletter'}
      </h2>
      {options ? (
        <EmailForm feature={feature} siteKey={options.siteKey} />
      ) : (
        <p role="status">{message || 'Loading…'}</p>
      )}
    </section>
  )
}

function EmailForm({
  feature,
  siteKey,
}: {
  feature: 'waitlist' | 'newsletter'
  siteKey: string | null
}) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const turnstile = useTurnstile(siteKey, feature)
  return (
    <form
      className="grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        try {
          const response = await fetch(`/api/${feature}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...turnstile.headers() },
            body: JSON.stringify({ email }),
          })
          const data = (await response.json()) as { error?: { message: string } }
          setMessage(
            response.ok
              ? feature === 'waitlist'
                ? 'You are on the waitlist.'
                : 'Check your email to confirm your subscription.'
              : (data.error?.message ?? 'Please try again.'),
          )
        } catch {
          setMessage('Unable to submit. Please try again.')
        } finally {
          turnstile.reset()
          setBusy(false)
        }
      }}
    >
      <label htmlFor={`${feature}-email`} className="grid gap-2">
        Email
        <Input
          id={`${feature}-email`}
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {turnstile.widget}
      <Button type="submit" disabled={busy || !turnstile.ready}>
        {busy ? 'Submitting…' : feature === 'waitlist' ? 'Join waitlist' : 'Subscribe'}
      </Button>
      <p role="status">{message}</p>
    </form>
  )
}
