import { env } from 'cloudflare:workers'
import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import { createCloudflareKv } from '@product-res/platform/cloudflare'
import { afterAll, describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth.ts'
import { parseEmailList, signupAllowlist } from '../src/signup-allowlist.ts'
import { APP_URL, app, PASSWORD, silenceExpectedErrors, testEnv, testUsers } from './helpers.ts'

const users = testUsers('signup-allowlist')
afterAll(() => users.cleanup())

describe('parseEmailList / signupAllowlist', () => {
  it('忽略大小写和空白，空值不限制', () => {
    expect([...parseEmailList(' A@x.test, b@x.test ,,')]).toEqual(['a@x.test', 'b@x.test'])
    expect(() => signupAllowlist('')('anyone@x.test')).not.toThrow()
    expect(() => signupAllowlist('a@x.test')('A@X.test')).not.toThrow()
    expect(() => signupAllowlist('a@x.test')('c@x.test')).toThrow()
  })
})

describe('注册白名单', () => {
  const invited = users.email('invited')
  const db = createDb(env.HYPERDRIVE)
  const auth = createAuth({ ...testEnv, SIGNUP_ALLOWED_EMAILS: ` ${invited.toUpperCase()} ` }, db, {
    cache: createCloudflareKv(env.CACHE),
    config: defineTemplateConfig({ app, auth: { turnstile: false } }),
    sendEmail: async () => {},
  })
  const signUp = (email: string) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, name: 'Allowlist' }),
      }),
    )

  it('名单外邮箱注册被拒，且不创建用户', async () => {
    silenceExpectedErrors()
    const outsider = users.email('outsider')
    const response = await signUp(outsider)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'SIGNUP_NOT_ALLOWED' })
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, outsider) }),
    ).toBeUndefined()
  })

  it('名单内邮箱（不区分大小写）可以注册', async () => {
    const response = await signUp(invited)
    expect(response.status).toBe(200)
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, invited) }),
    ).toBeDefined()
  })
})
