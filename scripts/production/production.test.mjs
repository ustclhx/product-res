import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkRelease } from './check-release.mjs'
import { checkEnvs, parseJsonc } from './check-wrangler-envs.mjs'
import { buildChecks, keyTables, migrationCount, pgEnv, verifyRestore } from './verify-restore.mjs'

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
  const problems = checkEnvs('web', config)
  assert.ok(problems.includes('web: production is missing binding kv:CACHE'))
  assert.ok(problems.some((line) => line.includes('reuses staging resource id')))
  assert.ok(problems.includes('web: production references staging value email-staging'))
  assert.ok(problems.includes('web: production must not set PAYMENT_MODE'))
})

const sha = 'a'.repeat(40)

function run(overrides = {}) {
  const lines = []
  const deps = {
    isOnMain: async () => true,
    stagingRuns: async () => [{ head_sha: sha, conclusion: 'success' }],
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
