import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkRollback } from './check-rollback.mjs'
import { checkCi, checkSentry } from './release-policy.mjs'

const sha = 'a'.repeat(40)
const current = 'b'.repeat(40)
const success = { head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' }
const quiet = { write: () => {}, summary: () => {} }

test('CI defaults to live and accepts only successful main push runs for the exact SHA', async () => {
  for (const runs of [
    [],
    [{ ...success, head_sha: current }],
    [{ ...success, head_branch: 'feature' }],
    [{ ...success, event: 'pull_request' }],
    [{ ...success, conclusion: 'failure' }],
  ]) {
    assert.equal(await checkCi(sha, { ...quiet, ciRuns: async () => runs }), 1)
  }
  assert.equal(await checkCi(sha, { ...quiet, ciRuns: async () => [success] }), 0)
})

test('testing bypass logs its type, reason and actor without querying CI', async () => {
  const logs = []
  const summaries = []
  assert.equal(
    await checkCi(sha, {
      phase: 'testing',
      actor: 'maintainer',
      write: (line) => logs.push(line),
      summary: (value) => summaries.push(value),
      ciRuns: () => assert.fail('must bypass CI query'),
    }),
    0,
  )
  assert.match(logs[0], /::warning.*testing.*RELEASE_PHASE=testing.*maintainer/)
  assert.match(summaries[0], /testing.*RELEASE_PHASE=testing.*maintainer/s)
})

test('testing bypass preserves an explicitly supplied reason', async () => {
  const summaries = []
  assert.equal(
    await checkCi(sha, {
      ...quiet,
      phase: 'testing',
      reason: 'pre-launch validation',
      summary: (value) => summaries.push(value),
    }),
    0,
  )
  assert.match(summaries[0], /pre-launch validation/)
})

test('hotfix bypass requires dispatch and a nonempty reason, and records escaped audit data', async () => {
  for (const options of [
    { event: 'push', reason: 'urgent' },
    { event: 'workflow_dispatch', reason: '  ' },
  ]) {
    assert.equal(await checkCi(sha, { ...quiet, bypass: 'hotfix', ...options }), 1)
  }
  const logs = []
  const summaries = []
  assert.equal(
    await checkCi(sha, {
      event: 'workflow_dispatch',
      bypass: 'hotfix',
      reason: 'outage\n::error::<script>',
      actor: 'operator',
      write: (line) => logs.push(line),
      summary: (value) => summaries.push(value),
    }),
    0,
  )
  assert.match(logs[0], /hotfix.*outage%0A.*operator/)
  assert.ok(!summaries[0].includes('<script>'))
})

test('unknown release phase fails closed', async () => {
  assert.equal(await checkCi(sha, { ...quiet, phase: 'test', ciRuns: async () => [success] }), 1)
})

test('Sentry configuration is required in live, including when the phase is unset', () => {
  assert.equal(checkSentry({}, quiet), 1)
  assert.equal(checkSentry({ RELEASE_PHASE: 'testing' }, quiet), 0)
  const config = {
    SENTRY_DSN: 'dsn',
    SENTRY_AUTH_TOKEN: 'token',
    SENTRY_ORG: 'org',
    SENTRY_PROJECT: 'project',
  }
  assert.equal(checkSentry(config, quiet), 0)
  assert.equal(checkSentry({ ...config, SENTRY_DSN: '' }, quiet), 1)
})

function rollback(options = {}) {
  return checkRollback(sha, {
    ...quiet,
    currentVersion: async () => current,
    isAncestor: async (a, b) => a === sha && b === current,
    addedMigrations: async () => ['packages/db/migrations/0016_change.sql'],
    migrationSql: async () =>
      '-- rollback-safe: adds a nullable column\nALTER TABLE x ADD COLUMN y text;',
    ...options,
  })
}

test('rollback allows only migrations with nonempty rollback-safe reasons', async () => {
  assert.equal(await rollback(), 0)
  for (const sql of [
    'ALTER TABLE x DROP COLUMN y;',
    '-- rollback-safe:   \nSELECT 1;',
    "SELECT '-- rollback-safe: not a comment';",
  ]) {
    assert.equal(await rollback({ migrationSql: async () => sql }), 1)
  }
})

test('rollback reads migration content from the running production SHA', async () => {
  await rollback({
    addedMigrations: async (target, running) => {
      assert.equal(target, sha)
      assert.equal(running, current)
      return ['packages/db/migrations/0016_change.sql']
    },
    migrationSql: async (running, file) => {
      assert.equal(running, current)
      assert.equal(file, 'packages/db/migrations/0016_change.sql')
      return '-- rollback-safe: expand only'
    },
  })
})

test('forward release and same version need no rollback migration declarations', async () => {
  assert.equal(await rollback({ currentVersion: async () => sha }), 0)
  assert.equal(
    await rollback({
      isAncestor: async (a, b) => a === current && b === sha,
      addedMigrations: () => assert.fail('forward release'),
    }),
    0,
  )
  assert.equal(await rollback({ addedMigrations: async () => [] }), 0)
})

test('rollback refuses unknown production versions and divergent history', async () => {
  assert.equal(await rollback({ currentVersion: async () => 'unknown' }), 1)
  assert.equal(await rollback({ isAncestor: async () => false }), 1)
  assert.equal(
    await rollback({
      currentVersion: async () => {
        throw new Error('unavailable')
      },
    }),
    1,
  )
})

test('rollback CLI uses real git history from an old checkout without release scripts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-rollback-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'release@example.test')
  mkdirSync(join(dir, 'packages/db/migrations'), { recursive: true })
  writeFileSync(join(dir, 'packages/db/migrations/0000_base.sql'), 'SELECT 1;')
  git('add', '.')
  git('commit', '-m', 'base')
  const target = git('rev-parse', 'HEAD')
  writeFileSync(
    join(dir, 'packages/db/migrations/0001_safe.sql'),
    '-- rollback-safe: expand only\nSELECT 1;',
  )
  git('add', '.')
  git('commit', '-m', 'safe migration')
  const safe = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'packages/db/migrations/0002_unsafe.sql'), 'DROP TABLE business;')
  git('add', '.')
  git('commit', '-m', 'unsafe migration')
  const unsafe = git('rev-parse', 'HEAD')
  git('checkout', target)
  const preload = join(dir, 'health.mjs')
  writeFileSync(
    preload,
    'globalThis.fetch = async () => new Response(JSON.stringify({ version: process.env.RUNNING_SHA }))',
  )
  const cli = fileURLToPath(new URL('./check-rollback.mjs', import.meta.url))
  const invoke = (current) =>
    spawnSync(process.execPath, ['--import', preload, cli, target], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, RUNNING_SHA: current, PRODUCTION_URL: 'https://production.example' },
    })
  const allowed = invoke(safe)
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.match(allowed.stderr, /0001_safe.sql/)
  const rejected = invoke(unsafe)
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.match(rejected.stderr, /0002_unsafe.sql lacks -- rollback-safe/)
})
