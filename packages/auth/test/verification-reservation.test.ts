import { isUuidV7, newId } from '@product-res/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { requireFreshSession } from '../src/fresh-session.ts'
import { cookieHeader, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('reservation')
afterAll(() => users.cleanup())
const app = () =>
  setup({
    config: { auth: { turnstile: false, magicLink: true } },
    rateLimiter: { limit: async () => ({ success: true }) },
  })

describe('UUID verification reservations in workerd', () => {
  it.each(['otp', 'magic-link'] as const)(
    '%s proves an existing unverified mailbox and revokes unproven access',
    async (method) => {
      const a = app()
      const email = users.email(method)
      const signup = await a.post('/sign-up/email', signUpBody(email))
      expect(signup.status).toBe(200)
      const { user } = (await signup.json()) as { user: { id: string } }
      const oldCookie = cookieHeader(signup)
      expect(
        (await a.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, user.id) }))
          ?.emailVerified,
      ).toBe(false)
      await a.db.$client`insert into account (id,user_id,account_id,provider_id)
        values (${newId()},${user.id},${email},'google')`
      let response: Response
      if (method === 'otp') {
        expect(
          (await a.post('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status,
        ).toBe(200)
        const proof = a.sent.find((mail) => mail.type === 'otp')
        if (proof?.type !== 'otp') throw new Error('OTP was not issued')
        response = await a.post('/sign-in/email-otp', { email, otp: proof.otp })
      } else {
        expect((await a.post('/sign-in/magic-link', { email })).status).toBe(200)
        const proof = a.sent.find((mail) => mail.type === 'magic-link')
        if (proof?.type !== 'magic-link') throw new Error('Magic link was not issued')
        response = await a.get(proof.url)
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).not.toContain('error=')
        response = await a.get('/get-session', { cookie: cookieHeader(response) })
      }
      expect(response.status).toBe(200)
      const signedIn = (await response.json()) as { user: { id: string; emailVerified: boolean } }
      expect(signedIn.user).toMatchObject({ id: user.id, emailVerified: true })
      expect(
        await a.db.query.account.findMany({ where: (acc, { eq }) => eq(acc.userId, user.id) }),
      ).toEqual([])
      await expect(
        requireFreshSession({
          auth: a.auth,
          db: a.db,
          headers: new Headers({ cookie: oldCookie }),
        }),
      ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
      expect((await a.post('/sign-in/email', { email, password: PASSWORD })).status).not.toBe(200)
      const sessions = await a.db.query.session.findMany({
        where: (s, { eq }) => eq(s.userId, user.id),
      })
      expect(sessions).toHaveLength(1)
      expect(isUuidV7(sessions[0]?.id ?? '')).toBe(true)
    },
  )

  it('serializes independent request reservations, releases by identifier and replaces expired markers', async () => {
    const a = app()
    const b = app()
    await Promise.all([a.get('/get-session'), b.auth.api.getSession({ headers: new Headers() })])
    const first = (await a.auth.$context).internalAdapter
    const second = (await b.auth.$context).internalAdapter
    const identifier = `reservation:${users.email('race')}`
    const data = { identifier, value: 'reserved', expiresAt: new Date(Date.now() + 60_000) }
    const results = await Promise.all([
      first.reserveVerificationValue(data),
      second.reserveVerificationValue(data),
    ])
    expect(results.sort()).toEqual([false, true])
    const rows = await a.db.query.verification.findMany({
      where: (v, { eq }) => eq(v.identifier, identifier),
    })
    expect(rows).toHaveLength(1)
    expect(isUuidV7(rows[0]?.id ?? '')).toBe(true)
    expect((await first.findVerificationValue(identifier))?.value).toBe('reserved')
    await first.deleteVerificationByIdentifier(identifier)
    expect(await second.reserveVerificationValue(data)).toBe(true)
    await a.db
      .$client`update verification set expires_at=now()-interval '1 second' where identifier=${identifier}`
    expect(await first.reserveVerificationValue(data)).toBe(true)
    expect(
      await a.db.query.verification.findMany({
        where: (v, { eq }) => eq(v.identifier, identifier),
      }),
    ).toHaveLength(1)
    await second.deleteVerificationByIdentifier(identifier)
  })
})
