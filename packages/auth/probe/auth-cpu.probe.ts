import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import { hashPassword as scryptHash, verifyPassword as scryptVerify } from 'better-auth/crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from '../src/password.ts'
import {
  cookieHeader,
  mockTurnstile,
  PASSWORD,
  setup,
  signUpBody,
  testUsers,
} from '../test/helpers.ts'

// tasks.md 2.4：在本地 workerd 中测量注册 / 登录 / 修改密码的耗时（说明见 README.md）。
// 运行：pnpm --filter @product-res/auth probe:cpu

const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 20)
const WARMUP = 3
const users = testUsers('cpu-probe')

beforeAll(() => {
  users.start()
  mockTurnstile()
})
afterAll(async () => {
  vi.restoreAllMocks()
  await users.cleanup()
})

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  }
}

async function time(fn: () => Promise<unknown>, rounds = ROUNDS) {
  for (let i = 0; i < WARMUP; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  return stats(samples)
}

/** 注册、登录（成功 / 密码错误）、修改密码；关闭 Turnstile 与 RL_AUTH，只测流程本身 */
async function measureFlows(setupFn: typeof setup, label: string) {
  const s = setupFn({ config: { auth: { turnstile: false } }, rateLimiter: undefined })
  const fresh = () => users.email(label)
  const out: Record<string, unknown> = {}
  out[`${label}.signUp`] = await time(async () => {
    expect((await s.post('/sign-up/email', signUpBody(fresh()))).status).toBe(200)
  })
  const address = fresh()
  const signUp = await s.post('/sign-up/email', signUpBody(address))
  out[`${label}.signIn`] = await time(async () => {
    expect((await s.post('/sign-in/email', { email: address, password: PASSWORD })).status).toBe(
      200,
    )
  })
  out[`${label}.signInWrongPassword`] = await time(async () => {
    const res = await s.post('/sign-in/email', { email: address, password: 'wrong-password-1' })
    expect(res.status).toBe(401)
  })
  const cookie = cookieHeader(signUp)
  let current = PASSWORD
  out[`${label}.changePassword`] = await time(async () => {
    const next = current === PASSWORD ? 'another-long-password-1' : PASSWORD
    const res = await s.post(
      '/change-password',
      { currentPassword: current, newPassword: next },
      { cookie },
    )
    expect(res.status).toBe(200)
    current = next
  })
  return out
}

it('密码哈希原语与认证流程耗时', { timeout: 600_000 }, async () => {
  const results: Record<string, unknown> = {}

  // 1. 本地 workerd 的时钟在纯计算期间是否推进（线上 Workers 只在 I/O 后推进）
  const t0 = performance.now()
  let x = 0
  for (let i = 0; i < 5e7; i++) x += i
  results.clockAdvancesDuringCpu = performance.now() - t0 > 1 && x > 0

  // 2. 哈希原语
  const scryptStored = await scryptHash(PASSWORD)
  const pbkdf2Stored = await hashPassword(PASSWORD)
  results.scryptHash = await time(() => scryptHash(PASSWORD))
  results.scryptVerify = await time(() => scryptVerify({ hash: scryptStored, password: PASSWORD }))
  results.pbkdf2Hash = await time(() => hashPassword(PASSWORD))
  results.pbkdf2Verify = await time(() =>
    verifyPassword({ hash: pbkdf2Stored, password: PASSWORD }),
  )
  results.pbkdf2Iterations = PBKDF2_ITERATIONS

  // 3. Workers 的 PBKDF2 迭代上限
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('x'), 'PBKDF2', false, [
    'deriveBits',
  ])
  results.pbkdf2OverLimit = await crypto.subtle
    .deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: new Uint8Array(16),
        iterations: PBKDF2_ITERATIONS + 1,
      },
      key,
      256,
    )
    .then(
      () => 'accepted',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    )

  // 4. 认证流程（经 auth.handler，含本地 PG 往返与 Miniflare KV）：当前 hasher（PBKDF2）与 Better Auth 默认的 scrypt
  Object.assign(results, await measureFlows(setup, 'pbkdf2'))
  vi.doMock('../src/password.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/password.ts')>()),
    passwordHasher: { hash: scryptHash, verify: scryptVerify },
  }))
  vi.resetModules()
  const scryptHelpers = await import('../test/helpers.ts')
  Object.assign(results, await measureFlows(scryptHelpers.setup, 'scrypt'))
  vi.doUnmock('../src/password.ts')

  const s = setup({ config: { auth: { turnstile: false } }, rateLimiter: undefined })
  const cookie = cookieHeader(await s.post('/sign-up/email', signUpBody(users.email('c'))))
  // 对照：不做密码哈希的请求（读会话，绕过 Cookie 缓存，KV 命中）
  results.getSessionNoCache = await time(async () => {
    expect((await s.get('/get-session?disableCookieCache=true', { cookie })).status).toBe(200)
  })
  // 对照：单次数据库往返
  const db = createDb(env.HYPERDRIVE)
  results.dbRoundTrip = await time(() => db.$client`select 1`)

  for (const [name, value] of Object.entries(results)) {
    console.log(`AUTH_CPU_PROBE ${name} ${JSON.stringify(value)}`)
  }
})
