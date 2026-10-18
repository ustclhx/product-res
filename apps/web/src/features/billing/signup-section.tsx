import { Button } from '@product-res/ui'
import { useEffect, useState } from 'react'
import { authClient } from '../auth/auth-client.ts'
import { claimSignupBonus } from './signup.functions.ts'

export function SignupBonusSection({
  verified,
  email,
  credits,
}: {
  email: string
  verified: boolean
  credits: number
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if (credits <= 0) return null
  async function claim() {
    setBusy(true)
    setMessage('')
    try {
      if (!verified) {
        const result = await authClient().sendVerificationEmail({ email, callbackURL: '/account' })
        if (result.error)
          throw new Error(result.error.message ?? 'Unable to send verification email')
        setMessage('Verification email sent. Your credits will be added after verification.')
      } else {
        const result = await claimSignupBonus()
        setMessage(
          result.status === 'granted'
            ? `Added ${result.credits} credits to your personal workspace.`
            : result.status === 'already_claimed'
              ? 'This email has already received its signup credits.'
              : result.status === 'blacklisted'
                ? 'This email domain is not eligible for signup credits.'
                : result.status === 'unverified'
                  ? 'Verify your email to receive signup credits.'
                  : 'Signup credits are unavailable.',
        )
      }
    } catch {
      setMessage('Unable to claim signup credits. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="rounded-xl border p-6">
      <h2 className="font-semibold">Signup credits</h2>
      <p>
        {verified
          ? 'Claim your signup credits, or retry if verification completed without adding them.'
          : `Verify your email to receive ${credits} credits in your personal workspace.`}
      </p>
      <Button type="button" disabled={!ready || busy} onClick={() => void claim()}>
        {busy
          ? 'Please wait…'
          : verified
            ? 'Claim signup credits'
            : `Verify email to claim ${credits} credits`}
      </Button>
      {message && <p role="status">{message}</p>}
    </section>
  )
}
