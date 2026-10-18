import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import { type EntitlementSubscription, selectEntitlements } from '@product-res/entitlements'
import postgres from 'postgres'
import templateConfig from '../../../../template.config.ts'
import { stubTurnstile } from '../turnstile.ts'
import {
  adminIdentity,
  checkUserReadiness,
  ensureAcceptanceCredits,
  ensureRegisteredAccount,
  guidancePrefix,
  HUMAN_LOGIN_TIMEOUT,
  sessionUser,
} from './accounts.ts'
import { classifyPgFailure, safeDiagnostic, TRANSIENT_PG_FAILURES } from './diagnostic.ts'
import { ACCEPTANCE_MODELS } from './models.ts'

export { adminIdentity, ensureRegisteredAccount, registerAccount, sessionUser } from './accounts.ts'

export { expect, test }
export const runId = process.env.STAGING_ACCEPTANCE_RUN_ID ?? new Date().toISOString().slice(0, 10)
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) throw new Error('Invalid STAGING_ACCEPTANCE_RUN_ID')
export const local = process.env.STAGING_ACCEPTANCE_LOCAL === '1'
// 同一 worker 内复用新鲜会话，避免每个用例登录触发真实认证限流；Cookie 不落盘或输出。
const sessions = new Map<string, Parameters<BrowserContext['addCookies']>[0]>()
// 只有真实 staging 证据进入 runbook；本地假服务商证据留在已忽略的 test-results。
const evidenceRoot = local ? 'test-results' : 'docs/runbooks/evidence'
const evidenceDir = new URL(
  `../../../../${evidenceRoot}/staging-acceptance/${new Date().toISOString().slice(0, 10)}/`,
  import.meta.url,
)

export async function readEvidence<T>(name: string): Promise<T | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence name')
  let payload: string
  try {
    payload = await readFile(new URL(`${runId}-${name}.json`, evidenceDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const saved = JSON.parse(payload)
  if (saved.runId !== runId || saved.target !== (local ? 'local-mocked' : 'staging-real'))
    throw new Error('Evidence identity mismatch')
  return saved.data as T
}

export function requireEnv(names: string[]) {
  const missing = names.filter((name) => !process.env[name])
  test.skip(missing.length > 0, `Missing environment variables: ${missing.join(', ')}`)
}

export function sqlLiteral(value: string) {
  if (value.includes('\0')) throw new Error('Invalid SQL literal')
  return `'${value.replaceAll("'", "''")}'`
}

// 每次查询新建连接（原先每条都 docker exec psql）在跨洋链路上握手需 2-4 秒、十余次往返，
// 偶发丢包会让整轮握手失败；改为同一 worker 复用单条只读连接，断线由驱动自动重连。
let readOnlyClient: postgres.Sql | undefined

function readOnlySql() {
  readOnlyClient ??= postgres(process.env.NEON_READONLY_URL ?? '', {
    max: 1,
    // Neon 缩容到零后首个连接需等计算节点唤醒。
    connect_timeout: 15,
    // 空闲连接自行关闭，避免中间设备静默丢弃后首条查询卡住，也不阻止 worker 退出。
    idle_timeout: 20,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
    // 会话级只读与语句超时作为第二道保险；事务本身也声明 READ ONLY。
    // Neon 代理会丢弃自定义启动参数，只转发 options 中的 -c 设置。
    connection: {
      application_name: 'staging-acceptance-readonly',
      options: '-c default_transaction_read_only=on -c statement_timeout=30s',
    },
  })
  return readOnlyClient
}

async function resetReadOnlyClient() {
  const client = readOnlyClient
  readOnlyClient = undefined
  await client?.end({ timeout: 0 }).catch(() => {})
}

// 只对连接类失败退避重试（只读查询可安全重放）；带抖动以免与瞬时网络抖动同相，总等待约 30 秒。
const QUERY_RETRY_DELAYS = [1_000, 3_000, 8_000, 15_000]
// 半开连接上驱动不会自行超时，客户端兜底时长需大于连接与语句超时之和。
const QUERY_DEADLINE = 50_000

export async function query<T extends Record<string, unknown>>(statement: string): Promise<T[]> {
  requireEnv(['NEON_READONLY_URL'])
  for (let attempt = 0; ; attempt++) {
    let category: ReturnType<typeof classifyPgFailure>
    try {
      return await runReadOnly<T>(statement)
    } catch (error) {
      category = classifyPgFailure(error)
    }
    // 丢弃可能处于异常状态的连接，下次重试重新握手。
    if (TRANSIENT_PG_FAILURES.has(category)) await resetReadOnlyClient()
    const delay = QUERY_RETRY_DELAYS[attempt]
    if (!TRANSIENT_PG_FAILURES.has(category) || delay === undefined)
      throw new Error(`Read-only evidence query failed (${category})`)
    await new Promise((resolve) => setTimeout(resolve, delay * (0.75 + Math.random() * 0.5)))
  }
}

async function runReadOnly<T>(statement: string) {
  // 连接串只在驱动内使用；SQL、行数据与驱动原始错误均不输出，只由调用方归类。
  const sql = readOnlySql()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('deadline'), { code: 'CONNECT_TIMEOUT' })),
      QUERY_DEADLINE,
    )
  })
  try {
    const rows = await Promise.race([
      sql.begin('isolation level repeatable read read only', async (tx) => {
        await tx`set local statement_timeout = '30s'`
        return tx.unsafe<{ rows: T[] }[]>(
          `select coalesce(json_agg(evidence_row), '[]'::json) as rows from (${statement}) as evidence_row`,
        )
      }),
      deadline,
    ])
    const result = rows[0]?.rows
    if (!Array.isArray(result)) throw new Error('Invalid read-only evidence result')
    return result
  } finally {
    clearTimeout(timer)
  }
}

const readyWorkspaces = new Set<string>()

async function checkOrdinaryUser(page: Page) {
  const user = await sessionUser(page)
  if (
    user.role
      ?.split(',')
      .map((role) => role.trim())
      .includes('admin')
  )
    throw new Error(`${guidancePrefix}普通验收用户不能是平台管理员`)
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const [workspace] = await query<{ id: string }>(`select o.id from organization o join member m
    on m.organization_id=o.id where o.slug=${sqlLiteral(slug)}
    and m.user_id=${sqlLiteral(user.id)} and o.deleted_at is null`)
  if (!workspace) throw new Error(`${guidancePrefix}普通验收用户空间不存在，请核对账号`)
  // 每个空间首次使用前检查，后续收费步骤会消耗余额，不重复要求初始 30 积分。
  if (readyWorkspaces.has(workspace.id)) return
  await test.step('只读检查普通用户模型权限与积分', async () => {
    const id = sqlLiteral(workspace.id)
    const [snapshot] = await query<{
      subscriptions: EntitlementSubscription[]
      free: Parameters<typeof selectEntitlements>[1] | null
      balance: number
      debt: number
      now: string
    }>(`select
      coalesce((select json_agg(json_build_object('status',s.status,
        'pastDueSince',s.past_due_since,'currentPeriodEnd',s.current_period_end,
        'plan',json_build_object('key',p.key,'sort',p.sort,'features',p.features)))
        from subscription s join plan p on p.id=s.plan_id where s.workspace_id=${id}), '[]'::json) as subscriptions,
      (select json_build_object('key',key,'sort',sort,'features',features) from plan where key='free') as free,
      (select coalesce(sum(remaining),0)::float8 from credit_grant where workspace_id=${id}
        and status='active' and (expires_at is null or expires_at>now())) as balance,
      (select coalesce(sum(amount),0)::float8 from credit_debt where workspace_id=${id}) as debt,
      now() as now`)
    if (!snapshot) throw new Error(`${guidancePrefix}无法读取普通用户权益与积分`)
    const entitlements = selectEntitlements(snapshot.subscriptions, snapshot.free ?? undefined, {
      now: new Date(snapshot.now),
      pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
    })
    const requiredModels = ACCEPTANCE_MODELS.map((model) => model.key)
    // 套餐与欠费仍需人工准备；缺权限时不能先发放测试积分。
    checkUserReadiness(
      user.id,
      workspace.id,
      entitlements.features.models,
      requiredModels,
      local ? snapshot.balance : undefined,
      snapshot.debt,
    )
    if (!local && snapshot.balance < 30) {
      await test.step('通过管理员后台幂等补发测试积分', async () => {
        const reason = `staging acceptance test credits ${runId}`
        const readAdjustments = () =>
          query<{ id: string }>(`select id from audit_log
          where workspace_id=${id} and action='credits.adjust'
          and meta->'input'->>'kind'='grant'
          and meta->'input'->>'reason'=${sqlLiteral(reason)} order by id`)
        const browser = page.context().browser()
        if (!browser) throw new Error(`${guidancePrefix}测试积分补发需要当前浏览器的管理员会话`)
        const context = await browser.newContext({ baseURL: process.env.STAGING_URL ?? '' })
        try {
          const adminPage = await context.newPage()
          await login(adminPage, 'admin')
          const admin = adminIdentity(await sessionUser(adminPage))
          if (admin.id === user.id)
            throw new Error(`${guidancePrefix}普通验收用户必须与当前管理员不同`)
          await adminPage.goto(`/admin/credits?workspaceId=${workspace.id}`)
          await ensureAcceptanceCredits(adminPage, readAdjustments, snapshot.balance, reason)
        } finally {
          await context.close()
        }
        const [balance] = await query<{ available: number; debt: number }>(`select
          (select coalesce(sum(remaining),0)::float8 from credit_grant where workspace_id=${id}
            and status='active' and (expires_at is null or expires_at>now())) as available,
          (select coalesce(sum(amount),0)::float8 from credit_debt where workspace_id=${id}) as debt`)
        if (!balance) throw new Error(`${guidancePrefix}无法确认测试积分余额，请管理员核对`)
        checkUserReadiness(
          user.id,
          workspace.id,
          entitlements.features.models,
          requiredModels,
          balance.available,
          balance.debt,
        )
      })
    }
    readyWorkspaces.add(workspace.id)
  })
}

async function confirmAdmin(page: Page) {
  adminIdentity(await sessionUser(page))
  await page.goto('/admin')
  if (new URL(page.url()).pathname !== '/admin')
    throw new Error(`${guidancePrefix}当前账号无法打开 /admin，请使用平台管理员账号登录`)
  try {
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
  } catch {
    throw new Error(`${guidancePrefix}当前账号无法打开 /admin，请使用平台管理员账号登录`)
  }
}

export async function login(page: Page, account: 'admin' | 'user') {
  requireEnv(['STAGING_URL'])
  const manualAdmin = account === 'admin' && !local
  if (!local && test.info().project.use.headless !== false)
    throw new Error(
      `${guidancePrefix}管理员登录与 Turnstile 需要 headed 模式，请在运行命令中加 --headed`,
    )
  if (!local) test.setTimeout(test.info().timeout + HUMAN_LOGIN_TIMEOUT)
  const prefix = account === 'admin' ? 'STAGING_ADMIN' : 'STAGING_USER'
  if (!manualAdmin) requireEnv([`${prefix}_EMAIL`, `${prefix}_PASSWORD`])
  if (account === 'user') requireEnv(['NEON_READONLY_URL'])
  if (local) {
    await page.context().setExtraHTTPHeaders({
      'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}`,
    })
    await stubTurnstile(page)
  }
  const finish = async () => {
    if (account === 'admin') await confirmAdmin(page)
    else await checkOrdinaryUser(page)
    sessions.set(prefix, await page.context().cookies())
  }
  const cached = sessions.get(prefix)
  if (cached) {
    await page.context().addCookies(cached)
    await page.goto('/app')
    if (/\/app\/[^/?#]+\/?$/.test(new URL(page.url()).pathname)) {
      await finish()
      return
    }
    sessions.delete(prefix)
    await page.context().clearCookies()
  }
  if (account === 'user') {
    const email = (process.env.STAGING_USER_EMAIL ?? '').trim().toLowerCase()
    const result = await ensureRegisteredAccount(
      page,
      async () =>
        (await query<{ id: string }>(`select id from "user" where email=${sqlLiteral(email)}`))[0],
      email,
      process.env.STAGING_USER_PASSWORD ?? '',
      'Staging acceptance ordinary user',
    )
    if (result.registered) {
      // 正常注册自动创建会话；直接验证该会话，避免再次提交登录或注册。
      await finish()
      return
    }
  }
  await page.goto('/login')
  if (manualAdmin) {
    process.stdout.write('请在弹出的浏览器中登录管理员账号（可使用 Google，等待时间 5 分钟）\n')
    const cdpUrl = process.env.STAGING_ADMIN_CDP_URL
    if (cdpUrl) {
      try {
        const browser = await chromium.connectOverCDP(cdpUrl)
        try {
          const context = browser.contexts()[0]
          if (!context) throw new Error('Missing Chrome default context')
          const adminPage = await context.newPage()
          try {
            const origin = new URL(process.env.STAGING_URL ?? '').origin
            await adminPage.goto(`${origin}/login`)
            await adminPage.waitForURL(
              (url) => url.origin === origin && url.pathname.startsWith('/app/'),
              { timeout: HUMAN_LOGIN_TIMEOUT },
            )
            // 只复制 staging 可用的 Cookie，Google 会话留在专用 Chrome profile 中。
            await page.context().addCookies(await context.cookies(origin))
          } finally {
            await adminPage.close()
          }
        } finally {
          // connectOverCDP 返回的 browser.close() 仅断开连接，不关闭系统 Chrome。
          await browser.close()
        }
      } catch (error) {
        // CDP 诊断可能包含端点或认证信息，只附带脱敏后的固定类别。
        throw new Error(
          `${guidancePrefix}系统 Chrome 登录失败（${safeDiagnostic(String(error))}），请检查 CDP 连接并在 5 分钟内完成登录`,
        )
      }
      await page.goto('/app')
    } else {
      try {
        await page.waitForURL(/\/app\/[^/?#]+\/?$/, { timeout: HUMAN_LOGIN_TIMEOUT })
      } catch {
        throw new Error(`${guidancePrefix}管理员登录等待超时，请重跑并在弹出的浏览器中完成登录`)
      }
    }
  } else {
    const form = page.getByRole('form', { name: 'Sign in with password' })
    await form.getByLabel('Email', { exact: true }).fill(process.env[`${prefix}_EMAIL`] ?? '')
    await form.getByLabel('Password', { exact: true }).fill(process.env[`${prefix}_PASSWORD`] ?? '')
    const timeout = local ? 20_000 : HUMAN_LOGIN_TIMEOUT
    await form.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout })
    await page.waitForURL(/\/app\/[^/?#]+\/?$/, { timeout })
  }
  await finish()
}

/** 只允许最小业务证明；递归检查字段别名，拒绝所有 URL 以覆盖未知签名格式。 */
export function assertSafeEvidence(data: unknown) {
  const payload = JSON.stringify(data)
  if (payload === undefined) throw new Error('Invalid evidence data')
  const secrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        value && /(?:PASSWORD|COOKIE|SECRET|TOKEN|KEY|DATABASE_URL|READONLY_URL)$/.test(key),
    )
    .map(([, value]) => value as string)
  const forbidden =
    /^(?:password|passwd|cookie|authorization|email|prompt|parts|text|content|body|payload|callbackPayload|input|output|message|partialText|completion|downloadUrl|url|signedUrl|connectionString|databaseUrl|apiKey|secret|token|accessToken|refreshToken)$/i
  const inspect = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(inspect)
    if (value && typeof value === 'object')
      return Object.entries(value).some(
        ([key, item]) => forbidden.test(key.replaceAll(/[_-]/g, '')) || inspect(item),
      )
    return false
  }
  if (
    inspect(data) ||
    secrets.some((value) => value.length > 3 && payload.includes(value)) ||
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(payload) ||
    /(?:https?:\/\/|postgres(?:ql)?:\/\/|Bearer\s|(?:X-Amz-|X-Goog-|Signature=|[?&](?:sig|token|signature)=))/i.test(
      payload,
    )
  )
    throw new Error('Evidence contains a forbidden sensitive value or field')
}

export async function evidence(name: string, data: unknown) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid evidence name')
  const payload = JSON.stringify(
    {
      runId,
      target: local ? 'local-mocked' : 'staging-real',
      recordedAt: new Date().toISOString(),
      data,
    },
    null,
    2,
  )
  assertSafeEvidence(data)
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(new URL(`${runId}-${name}.json`, evidenceDir), `${payload}\n`)
}

export async function reconcile(workspaceId: string) {
  const id = sqlLiteral(workspaceId)
  const [snapshot] = await query<{
    ledgerTotal: number
    activeRemaining: number
    held: number
    debt: number
  }>(`SELECT
    (SELECT coalesce(sum(delta),0) FROM credit_ledger WHERE workspace_id=${id}) AS "ledgerTotal",
    (SELECT coalesce(sum(remaining),0) FROM credit_grant WHERE workspace_id=${id} AND status='active') AS "activeRemaining",
    (SELECT coalesce(sum(amount),0) FROM credit_hold WHERE workspace_id=${id} AND status='held') AS held,
    (SELECT coalesce(sum(amount),0) FROM credit_debt WHERE workspace_id=${id}) AS debt`)
  if (!snapshot) throw new Error('Missing credit snapshot')
  const expectedTotal = snapshot.activeRemaining + snapshot.held - snapshot.debt
  const difference = snapshot.ledgerTotal - expectedTotal
  expect(difference, 'Credit reconciliation invariant').toBe(0)
  return { ...snapshot, expectedTotal, difference, consistent: difference === 0 }
}
