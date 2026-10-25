import { env } from 'cloudflare:workers'
import { defineTemplateConfig, type TemplateConfigInput } from '@product-res/config'
import { createDb, type Database } from '@product-res/db'
import type { KeyValueStore, RateLimiter } from '@product-res/platform'
import {
  createCloudflareKv,
  createCloudflareRateLimiter,
  createCloudflareRequestMetadata,
} from '@product-res/platform/cloudflare'
import { newId } from '@product-res/shared'
import { onTestFinished, vi } from 'vitest'
import { type AuthEmail, type AuthEnv, createAuth } from '../src/index.ts'
import { TURNSTILE_SITEVERIFY_URL, TURNSTILE_TOKEN_HEADER } from '../src/protection.ts'

// 集成测试共用：在 workerd 中经 Hyperdrive 连接本地 PG；OAuth 凭据为假值，邮件发送为记录调用的假实现，
// Turnstile siteverify 由 `mockTurnstile` 拦截，不访问任何外部服务。

export const APP_URL = 'http://localhost:3000'

/** Cloudflare 官方 Turnstile 测试 secret：始终通过 / 始终失败 */
export const TURNSTILE_PASS_SECRET = '1x0000000000000000000000000000000AA'
export const TURNSTILE_FAIL_SECRET = '2x0000000000000000000000000000000AA'
/** 官方测试站点密钥生成的假令牌 */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

export const testEnv = {
  BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  APP_URL,
  GOOGLE_CLIENT_ID: 'fake-google-id',
  GOOGLE_CLIENT_SECRET: 'fake-google-secret',
  GITHUB_CLIENT_ID: 'fake-github-id',
  GITHUB_CLIENT_SECRET: 'fake-github-secret',
  TURNSTILE_SECRET_KEY: TURNSTILE_PASS_SECRET,
} satisfies AuthEnv

export const app = { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' }
export const PASSWORD = 'correct-horse-battery-staple'

/**
 * 按 Cloudflare 文档中测试 secret 的行为模拟 siteverify：
 * 通过的 secret 对任意非空令牌返回 success，失败的 secret 一律返回 invalid-input-response。
 * 其他请求原样放行。返回 spy，可断言调用次数。
 */
export function mockTurnstile() {
  const original = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== TURNSTILE_SITEVERIFY_URL) return original(input, init)
    const form = init?.body instanceof FormData ? init.body : new FormData()
    const success = form.get('secret') === TURNSTILE_PASS_SECRET && Boolean(form.get('response'))
    return Response.json(
      success ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] },
    )
  })
}

/**
 * 静音当前测试中预期出现的错误日志（Better Auth 的 ERROR 日志、better-call 的 SERVER_ERROR）。
 * 只吞掉与任一 pattern 匹配的 `console.error`，其他错误照常输出，不会掩盖非预期错误；
 * 不改变生产代码的日志行为。spy 在当前测试结束时还原。
 */
export function silenceExpectedErrors(...patterns: RegExp[]) {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
    if (!patterns.some((p) => p.test(text.join(' ')))) original(...args)
  })
  onTestFinished(() => spy.mockRestore())
  return spy
}

/** 每个测试文件一个邮箱域名，结束时按域名清理 */
export function testUsers(prefix: string) {
  const domain = `${newId()}.${prefix}.auth-test.example`
  const createdOrgs: string[] = []
  return {
    email: (name: string) => `${name}-${newId()}@${domain}`,
    createdOrgs,
    start() {
      // Retained for existing test lifecycle callers; cleanup is scoped by ownership.
    },
    // 清理用原始 SQL：本包不直接依赖 drizzle-orm（better-auth 会引入另一个带 kysely 的 drizzle-orm 变体，
    // 两者的 SQL 类型不兼容），查询断言用 @product-res/db 实例自带的 relational query API。
    async cleanup() {
      const sql = createDb(env.HYPERDRIVE).$client
      const users = await sql<
        { id: string }[]
      >`select id from "user" where email like ${`%@${domain}`}`
      const ids = users.map((u) => u.id)
      // Each file owns a unique domain. Never erase challenges/manifests from parallel files.
      await sql`delete from verification where identifier like ${`%@${domain}%`} or value like ${`%@${domain}%`}`
      if (ids.length) await sql`delete from verification where value in ${sql(ids)}`
      if (ids.length === 0) return
      await sql`delete from session where user_id in ${sql(ids)}`
      // 个人空间的 id 即用户 id（personal-workspace.ts）
      const orgs = [...ids, ...createdOrgs]
      await createDb(env.HYPERDRIVE_MIGRATOR)
        .$client`delete from audit_log where actor_user_id in ${sql(ids)} or workspace_id in ${sql(orgs)}
          or (target_type = 'user' and target_id in ${sql(ids)})`
      await sql`delete from invitation where organization_id in ${sql(orgs)} or inviter_id in ${sql(ids)}`
      await sql`delete from workspace_invite_link where workspace_id in ${sql(orgs)} or created_by in ${sql(ids)}`
      await sql`delete from member where organization_id in ${sql(orgs)} or user_id in ${sql(ids)}`
      await sql`delete from organization where id in ${sql(orgs)}`
      await sql`delete from account where user_id in ${sql(ids)}`
      await sql`delete from "user" where id in ${sql(ids)}`
    },
  }
}

/** audit_log 对 app 只追加，读取 / 清理审计行用 migrator 连接 */
export const migratorDb = () => createDb(env.HYPERDRIVE_MIGRATOR)

let ipCounter = 0
/** 每次调用返回一个新的客户端 IP，避免不同场景共用 RL_AUTH 的 IP 计数 */
export const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`

/**
 * 与时间无关的 RL_AUTH 替身：每个 key 最多放行 `limit` 次，此后一律拒绝，计数永不重置。
 * Miniflare 模拟的 Rate Limiting 绑定按墙钟对齐固定窗口（`floor(Date.now() / period)`），
 * 测试若跨过整分钟边界，计数会被清零、结果整体偏移；需要断言精确放行次数的测试改用本替身。
 */
export function countingRateLimiter(limit = 5) {
  const counts = new Map<string, number>()
  return {
    async limit(_policy: string, key: string) {
      const count = counts.get(key) ?? 0
      if (count >= limit) return { success: false }
      counts.set(key, count + 1)
      return { success: true }
    },
  }
}

export interface SetupOptions {
  readonly config?: Omit<TemplateConfigInput, 'app'>
  readonly env?: Partial<AuthEnv>
  readonly cache?: KeyValueStore | undefined
  readonly rateLimiter?: RateLimiter | undefined
  readonly db?: Database
  readonly maxSeats?: number
}

/**
 * 创建一个 auth 实例与发请求的辅助函数。默认带 KV（CACHE）与 RL_AUTH 绑定、Turnstile 测试令牌，
 * 以及本次 setup 独有的客户端 IP。
 */
export function setup(options: SetupOptions = {}) {
  const sent: AuthEmail[] = []
  const db = options.db ?? createDb(env.HYPERDRIVE)
  const cache = 'cache' in options ? options.cache : createCloudflareKv(env.CACHE)
  const rateLimiter =
    'rateLimiter' in options ? options.rateLimiter : createCloudflareRateLimiter(env)
  const makeAuth = (clientIp: string | null) =>
    createAuth({ ...testEnv, ...options.env }, db, {
      cache,
      rateLimiter,
      clientIp,
      config: defineTemplateConfig({ app, ...options.config }),
      resolveMaxSeats: async () => options.maxSeats ?? null,
      sendEmail: async (message) => {
        sent.push(message)
      },
    })
  const ip = nextIp()
  let auth = makeAuth(ip)
  const request = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const req = new Request(path.startsWith('http') ? path : `${APP_URL}/api/auth${path}`, {
      method,
      headers: {
        origin: APP_URL,
        'cf-connecting-ip': ip,
        [TURNSTILE_TOKEN_HEADER]: TURNSTILE_DUMMY_TOKEN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    auth = makeAuth(createCloudflareRequestMetadata(req).clientIp)
    return auth.handler(req)
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request('POST', path, body, headers)
  const get = (path: string, headers: Record<string, string> = {}) =>
    request('GET', path, undefined, headers)
  return {
    get auth() {
      return auth
    },
    db,
    sent,
    ip,
    request,
    post,
    get,
  }
}

export const signUpBody = (address: string, password = PASSWORD) => ({
  email: address,
  password,
  name: 'Test User',
})

/** 从响应中取出全部 Set-Cookie，拼成请求用的 Cookie 头（只保留 name=value） */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c !== '' && !c.endsWith('='))
    .join('; ')
}

/** 只保留会话 token Cookie（去掉 session_data 缓存 Cookie），用于跳过 Cookie 缓存层 */
export function withoutCookieCache(cookie: string): string {
  return cookie
    .split('; ')
    .filter((c) => !c.includes('session_data'))
    .join('; ')
}
