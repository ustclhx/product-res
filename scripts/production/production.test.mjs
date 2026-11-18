import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkRelease } from './check-release.mjs'
import {
  checkEnvs,
  checkSiteVars,
  parseJsonc,
  parsePlausibleSites,
  resolvePlausibleSite,
} from './check-wrangler-envs.mjs'
import { buildChecks, keyTables, migrationCount, pgEnv, verifyRestore } from './verify-restore.mjs'

/** 只验证单项规则的最小 web 配置：三个环境都带 RL_SHARE_CARD，namespace_id 各不相同。 */
const shareCardLimit = (namespace_id) => [
  { name: 'RL_SHARE_CARD', namespace_id, simple: { limit: 30, period: 60 } },
]

const wrangler = (app) =>
  parseJsonc(readFileSync(new URL(`../../apps/${app}/wrangler.jsonc`, import.meta.url), 'utf8'))

test('JSONC parser keeps // inside strings and drops comments and trailing commas', () => {
  assert.deepEqual(parseJsonc('{ "url": "https://a.b", // c\n "x": [1, 2,], /* d */ }'), {
    url: 'https://a.b',
    x: [1, 2],
  })
})

// 本项目只部署 selfhost，生成器把 Cloudflare 资源 ID 置为零占位，真实配置检查不适用
test.skip('real web and jobs configs keep production aligned with staging', () => {
  for (const app of ['web', 'jobs']) assert.deepEqual(checkEnvs(app, wrangler(app)), [])
})

test('production drift, staging reuse and forbidden vars are reported', () => {
  const config = wrangler('web')
  const production = config.env.production
  production.kv_namespaces = []
  production.hyperdrive[0].id = config.env.staging.hyperdrive[0].id
  production.queues.producers[0].queue = 'email-staging'
  production.vars.PAYMENT_MODE = 'live'
  production.vars.UI_PREVIEW = 'true'
  const problems = checkEnvs('web', config)
  assert.ok(problems.includes('web: production is missing binding kv:CACHE'))
  assert.ok(problems.some((line) => line.includes('reuses staging resource id')))
  assert.ok(problems.includes('web: production references staging value email-staging'))
  assert.ok(problems.includes('web: production must not set PAYMENT_MODE'))
  assert.ok(problems.includes('web: production must not set UI_PREVIEW'))
})

test('web declares RL_SHARE_CARD in every environment with its own namespace', () => {
  for (const environment of ['top-level', 'staging', 'production']) {
    const config = wrangler('web')
    const env = environment === 'top-level' ? config : config.env[environment]
    env.ratelimits = env.ratelimits.filter((item) => item.name !== 'RL_SHARE_CARD')
    // production 缺少时同时触发绑定集合不一致，这里只断言本条规则。
    assert.ok(
      checkEnvs('web', config).includes(`web: ${environment} is missing ratelimit RL_SHARE_CARD`),
    )
  }
  const shared = wrangler('web')
  const card = shared.env.staging.ratelimits.find((item) => item.name === 'RL_SHARE_CARD')
  card.namespace_id = shared.ratelimits.find((item) => item.name === 'RL_SHARE_CARD').namespace_id
  assert.ok(
    checkEnvs('web', shared).some((line) =>
      line.includes(`namespace_id ${card.namespace_id} is shared by top-level RL_SHARE_CARD`),
    ),
  )
})

test('production jobs must declare a Cron profile that matches its triggers', () => {
  const missing = wrangler('jobs')
  delete missing.env.production.vars.CRON_PROFILE
  assert.ok(
    checkEnvs('jobs', missing).includes(
      'jobs: production CRON_PROFILE must be declared as reduced or default',
    ),
  )
  const mismatch = wrangler('jobs')
  mismatch.env.production.triggers.crons = ['*/5 * * * *']
  assert.ok(
    checkEnvs('jobs', mismatch).includes(
      'jobs: production crons do not match CRON_PROFILE=reduced',
    ),
  )
})

const sha = 'a'.repeat(40)

function run(overrides = {}) {
  const lines = []
  const deps = {
    isOnMain: async () => true,
    stagingRuns: async () => [{ head_sha: sha, conclusion: 'success' }],
    ciRuns: async () => [
      { head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' },
    ],
    write: (line) => lines.push(line),
    ...overrides,
  }
  const target = 'sha' in overrides ? overrides.sha : sha
  return checkRelease(target, deps).then((code) => ({ code, lines }))
}

test('accepts a main commit with a successful staging deployment', async () => {
  const { code, lines } = await run()
  assert.equal(code, 0)
  assert.match(lines[0], /deployed to staging/)
})

test('rejects a commit that is not on main before querying staging runs', async () => {
  let queried = false
  const { code, lines } = await run({
    isOnMain: async () => false,
    stagingRuns: async () => {
      queried = true
      return []
    },
  })
  assert.equal(code, 1)
  assert.equal(queried, false)
  assert.match(lines[0], /not on main/)
})

test('rejects a commit without a successful staging deployment of the same SHA', async () => {
  const other = 'b'.repeat(40)
  for (const runs of [
    [],
    [{ head_sha: sha, conclusion: 'failure' }],
    [{ head_sha: other, conclusion: 'success' }],
  ]) {
    const { code, lines } = await run({ stagingRuns: async () => runs })
    assert.equal(code, 1)
    assert.match(lines[0], /no successful Deploy staging run/)
  }
})

test('rejects abbreviated or malformed SHAs', async () => {
  for (const value of [undefined, '', 'abc1234', 'z'.repeat(40)]) {
    const { code } = await run({ sha: value })
    assert.equal(code, 1)
  }
})

test('restore checks compare migrations with the journal and add role checks only on request', () => {
  assert.equal(migrationCount(JSON.stringify({ entries: [{}, {}, {}] })), 3)
  const base = buildChecks({ expectedMigrations: 16 })
  assert.deepEqual(
    base.map((check) => check.name),
    ['pg17', 'migrations', 'business_tables', 'constraints', 'credits_balance'],
  )
  assert.match(base[1].sql, /count\(\*\) = 16 FROM drizzle\.__drizzle_migrations/)
  assert.deepEqual(
    buildChecks({ expectedMigrations: 16, roles: true })
      .slice(-2)
      .map((check) => check.name),
    ['roles', 'role_permissions'],
  )
})

test('restore connection is split into PG env vars', () => {
  assert.deepEqual(pgEnv('postgresql://ro%40x:p%2Fw@db.example:6543/saas?sslmode=require'), {
    PGHOST: 'db.example',
    PGPORT: '6543',
    PGUSER: 'ro@x',
    PGPASSWORD: 'p/w',
    PGDATABASE: 'saas',
    PGSSLMODE: 'require',
  })
})

test('restore verification fails when any check is false and never prints credentials', () => {
  const lines = []
  const code = verifyRestore({
    url: 'postgresql://readonly:secret-pw@db.example/saas',
    write: (line) => lines.push(line),
    run: (sql) => {
      if (sql.startsWith('SELECT count(*) FROM public')) return { ok: true, value: '7' }
      if (sql.includes('credit_ledger')) return { ok: true, value: 'f' }
      return { ok: true, value: 't' }
    },
  })
  assert.equal(code, 1)
  assert.ok(lines.includes('{"check":"credits_balance","ok":false}'))
  assert.equal(lines.filter((line) => line.includes('"rows":7')).length, keyTables.length)
  assert.ok(lines.every((line) => !line.includes('secret-pw') && !line.includes('db.example')))
})

test('production requires successful main push CI in addition to staging', async () => {
  const { code } = await run({ ciRuns: async () => [] })
  assert.equal(code, 1)
})

test('testing CI bypass still requires main ancestry and staging success', async () => {
  assert.equal((await run({ phase: 'testing', isOnMain: async () => false })).code, 1)
  assert.equal((await run({ phase: 'testing', stagingRuns: async () => [] })).code, 1)
})

test('site vars: staging must not share production site settings, web and jobs must agree', () => {
  const env = (vars) => ({
    ratelimits: shareCardLimit('1'),
    env: {
      staging: { vars, ratelimits: shareCardLimit('2') },
      production: {
        vars: { APP_URL: 'https://a.example', PLAUSIBLE_DOMAIN: 'a' },
        ratelimits: shareCardLimit('3'),
      },
    },
  })
  assert.match(checkEnvs('web', env({ APP_URL: 'https://a.example' })).join(), /share APP_URL/)
  assert.match(
    checkEnvs('web', env({ APP_URL: 'https://s.example', PLAUSIBLE_DOMAIN: 'a' })).join(),
    /share PLAUSIBLE_DOMAIN/,
  )
  assert.deepEqual(
    checkEnvs('web', env({ APP_URL: 'https://s.example', PLAUSIBLE_DOMAIN: 'a-staging' })),
    [],
  )
  const web = env({ APP_URL: 'https://s.example', PLAUSIBLE_DOMAIN: 'a-staging' })
  assert.deepEqual(checkSiteVars(web, web), [])
  assert.match(
    checkSiteVars(web, env({ APP_URL: 'https://s.example', PLAUSIBLE_DOMAIN: 'other' })).join(),
    /disagree on PLAUSIBLE_DOMAIN/,
  )
})

// 与 @product-res/config 的 analytics.test.ts 读取同一份用例，门禁与运行时解析不能各自漂移。
const sitesCases = JSON.parse(
  readFileSync(
    new URL('../../packages/config/src/plausible-sites.cases.json', import.meta.url),
    'utf8',
  ),
).cases
for (const item of sitesCases)
  test(`PLAUSIBLE_SITES shared case: ${item.name}`, () => {
    const parsed = parsePlausibleSites(item.raw)
    if (item.error) {
      assert.ok(parsed.error)
      return
    }
    assert.deepEqual(parsed, { sites: item.sites })
    for (const [host, fallback, expected] of item.resolve ?? [])
      assert.equal(resolvePlausibleSite(parsed.sites, fallback, host), expected)
  })

test('site vars: PLAUSIBLE_SITES must parse, stay apart across environments and match in web/jobs', () => {
  const config = (staging, production) => ({
    ratelimits: shareCardLimit('1'),
    env: {
      staging: {
        vars: { APP_URL: 'https://s.example', ...staging },
        ratelimits: shareCardLimit('2'),
      },
      production: {
        vars: { APP_URL: 'https://a.example', ...production },
        ratelimits: shareCardLimit('3'),
      },
    },
  })
  const production = { PLAUSIBLE_SITES: 'a.example=a,b.example=b' }
  assert.deepEqual(checkEnvs('web', config({}, production)), [])
  assert.deepEqual(
    checkEnvs('web', config({ PLAUSIBLE_SITES: 's.a.example=a-staging' }, production)),
    [],
  )
  assert.match(
    checkEnvs('web', config({ PLAUSIBLE_SITES: 's.example=b' }, production)).join(),
    /share Plausible site b/,
  )
  // staging 兜底等于生产映射里的 site，同样串站。
  assert.match(
    checkEnvs('web', config({ PLAUSIBLE_DOMAIN: 'a' }, production)).join(),
    /share Plausible site a/,
  )
  assert.match(
    checkEnvs('web', config({ PLAUSIBLE_SITES: 'x.example=a' }, { PLAUSIBLE_DOMAIN: 'a' })).join(),
    /share Plausible site a/,
  )
  for (const bad of ['a.example', '=a', 'a.example=a,'])
    assert.match(
      checkEnvs('web', config({}, { PLAUSIBLE_SITES: bad })).join(),
      /env\.production PLAUSIBLE_SITES/,
    )
  const web = config({}, production)
  assert.deepEqual(checkSiteVars(web, web), [])
  assert.match(
    checkSiteVars(web, config({}, { PLAUSIBLE_SITES: 'a.example=a' })).join(),
    /production: web and jobs disagree on PLAUSIBLE_SITES/,
  )
})

test('UI_PREVIEW opens /dev/ui in development and staging only (add-ui-design-system D6)', () => {
  const config = wrangler('web')
  assert.equal(config.vars.UI_PREVIEW, 'true')
  assert.equal(config.env.staging.vars.UI_PREVIEW, 'true')
  assert.equal('UI_PREVIEW' in config.env.production.vars, false)
  assert.equal('UI_PREVIEW' in (wrangler('jobs').env.production.vars ?? {}), false)
})
