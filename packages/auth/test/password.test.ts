import { hashPassword as scryptHash } from 'better-auth/crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from '../src/password.ts'
import { cookieHeader, mockTurnstile, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

// 密码哈希改用 PBKDF2（tasks.md 2.4，实测见 docs/04-auth-and-tenancy.md §1「密码哈希」）：
// 注册、登录、修改密码均成功，且兼容 Better Auth 默认 scrypt 格式的已有哈希。

const users = testUsers('password')

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

const credentialOf = (s: ReturnType<typeof setup>, userId: string) =>
  s.db.query.account.findFirst({
    where: (a, { and, eq }) => and(eq(a.userId, userId), eq(a.providerId, 'credential')),
  })

describe('PBKDF2 hasher', () => {
  it('哈希带算法与迭代次数，正确密码通过、错误密码失败，同一密码每次 salt 不同', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$[^$]+\\$[^$]+$`))
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true)
    expect(await verifyPassword({ hash, password: `${PASSWORD}x` })).toBe(false)
    expect(await hashPassword(PASSWORD)).not.toBe(hash)
  })

  it('兼容 Better Auth 默认的 scrypt 哈希', async () => {
    const legacy = await scryptHash(PASSWORD)
    expect(await verifyPassword({ hash: legacy, password: PASSWORD })).toBe(true)
    expect(await verifyPassword({ hash: legacy, password: 'nope-nope-nope' })).toBe(false)
  })

  it('格式损坏的哈希校验失败', async () => {
    expect(await verifyPassword({ hash: 'pbkdf2-sha256$abc$$', password: PASSWORD })).toBe(false)
  })
})

describe('认证流程', () => {
  it('注册、登录、修改密码均成功，库中保存 PBKDF2 哈希', async () => {
    const s = setup()
    const address = users.email('flow')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    expect(signUp.status).toBe(200)
    const { user } = (await signUp.json()) as { user: { id: string } }
    const before = await credentialOf(s, user.id)
    expect(before?.password).toMatch(/^pbkdf2-sha256\$/)

    const signIn = await s.post('/sign-in/email', { email: address, password: PASSWORD })
    expect(signIn.status).toBe(200)
    const cookie = cookieHeader(signIn)

    const newPassword = 'a-brand-new-password-42'
    const change = await s.post(
      '/change-password',
      { currentPassword: PASSWORD, newPassword },
      { cookie },
    )
    expect(change.status).toBe(200)
    const after = await credentialOf(s, user.id)
    expect(after?.password).toMatch(/^pbkdf2-sha256\$/)
    expect(after?.password).not.toBe(before?.password)

    expect((await s.post('/sign-in/email', { email: address, password: PASSWORD })).status).toBe(
      401,
    )
    expect((await s.post('/sign-in/email', { email: address, password: newPassword })).status).toBe(
      200,
    )
  })

  it('修改密码时当前密码错误被拒绝', async () => {
    const s = setup()
    const address = users.email('wrong-current')
    const cookie = cookieHeader(await s.post('/sign-up/email', signUpBody(address)))
    const res = await s.post(
      '/change-password',
      { currentPassword: 'not-the-password', newPassword: 'whatever-password-1' },
      { cookie },
    )
    expect(res.status).toBe(400)
  })

  it('切换前以 scrypt 保存的密码仍可登录', async () => {
    const s = setup()
    const address = users.email('legacy')
    const signUp = await s.post('/sign-up/email', signUpBody(address))
    const { user } = (await signUp.json()) as { user: { id: string } }
    const legacy = await scryptHash(PASSWORD)
    await s.db
      .$client`update account set password = ${legacy} where user_id = ${user.id} and provider_id = 'credential'`
    expect((await s.post('/sign-in/email', { email: address, password: PASSWORD })).status).toBe(
      200,
    )
  })
})
