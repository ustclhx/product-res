import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthEmail } from '../src/index.ts'
import { cookieHeader, mockTurnstile, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

// 邮箱验证（tasks.md 2.6，specs/user-auth「邮箱验证」）：
// 默认不强制；`auth.requireEmailVerification=true` 时注册即发验证邮件、未验证不能登录。

const users = testUsers('verify')

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

const verifyEmails = (sent: AuthEmail[]) =>
  sent.flatMap((m) => (m.type === 'verify-email' ? [m] : []))

const isVerified = async (s: ReturnType<typeof setup>, address: string) =>
  (await s.db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, address) }))?.emailVerified

/** 打开邮件中的验证链接（不跟随重定向） */
const openLink = (s: ReturnType<typeof setup>, url: string) =>
  s.auth.handler(new Request(url, { redirect: 'manual' }))

describe('默认配置（不强制验证）', () => {
  it('注册不发验证邮件，未验证即可登录', async () => {
    const s = setup()
    const address = users.email('default')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    expect(signUp.status).toBe(200)
    // 注册后直接拿到会话
    expect(cookieHeader(signUp)).toContain('session_token=')
    const signIn = await s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(signIn.status).toBe(200)
    expect(s.sent).toEqual([])
    expect(await isVerified(s, address)).toBe(false)
  })

  it('已登录用户主动发起验证：发送验证邮件，点击链接后变为已验证', async () => {
    const s = setup()
    const address = users.email('on-demand')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    const cookie = cookieHeader(signUp)

    const res = await s.post(
      '/send-verification-email',
      { email: address, callbackURL: '/app' },
      { cookie },
    )
    expect(res.status).toBe(200)
    const [mail] = verifyEmails(s.sent)
    expect(mail?.to).toBe(address)

    const opened = await openLink(s, mail?.url ?? '')
    expect(opened.status).toBe(302)
    expect(opened.headers.get('location')).toBe('/app')
    expect(await isVerified(s, address)).toBe(true)

    // 已验证后再次发起返回错误，不再发邮件（浏览器使用验证响应下发的新 Cookie）
    const refreshed = cookieHeader(opened)
    expect(refreshed).toContain('session_token=')
    const again = await s.post(
      '/send-verification-email',
      { email: address },
      { cookie: refreshed },
    )
    expect(again.status).toBe(400)
    expect(verifyEmails(s.sent)).toHaveLength(1)
  })

  it('不能为其他账号的邮箱发起验证', async () => {
    const s = setup()
    const mine = users.email('mine')
    const cookie = cookieHeader(await s.post('/sign-up/email', signUpBody(mine)))
    const other = users.email('other')
    await s.post('/sign-up/email', signUpBody(other))
    const res = await s.post('/send-verification-email', { email: other }, { cookie })
    expect(res.status).toBe(400)
    expect(s.sent).toEqual([])
  })
})

describe('强制验证（requireEmailVerification=true）', () => {
  const strict = () => setup({ config: { auth: { requireEmailVerification: true } } })

  it('注册即发验证邮件，且不创建会话', async () => {
    const s = strict()
    const address = users.email('strict-signup')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    expect(signUp.status).toBe(200)
    expect(cookieHeader(signUp)).not.toContain('session_token=')
    expect(verifyEmails(s.sent).map((m) => m.to)).toEqual([address])
  })

  it('未验证时登录被拒绝并重新发送验证邮件；验证后可以登录', async () => {
    const s = strict()
    const address = users.email('strict-signin')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)

    const denied = await s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED')
    expect(cookieHeader(denied)).not.toContain('session_token=')
    // 注册时 1 封，被拒的登录又发 1 封
    const mails = verifyEmails(s.sent)
    expect(mails).toHaveLength(2)

    const opened = await openLink(s, mails.at(-1)?.url ?? '')
    expect(opened.status).toBe(302)
    expect(await isVerified(s, address)).toBe(true)

    const signIn = await s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(signIn.status).toBe(200)
    expect(cookieHeader(signIn)).toContain('session_token=')
  })

  it('密码错误时不发验证邮件', async () => {
    const s = strict()
    const address = users.email('strict-wrong')
    expect((await s.post('/sign-up/email', signUpBody(address))).status).toBe(200)
    const res = await s.post('/sign-in/email', { email: address, password: 'wrong-password-123' })
    expect(res.status).toBe(401)
    expect(verifyEmails(s.sent)).toHaveLength(1)
  })
})
