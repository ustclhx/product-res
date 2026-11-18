import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkIgnoreReasons, lintMigrations } from './lint-migrations.mjs'
import { migrationUrl, runMigrations } from './migrate.mjs'

const require = createRequire(new URL('../../packages/db/package.json', import.meta.url))
const postgres = require('postgres')

function fixture(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-safety-'))
  mkdirSync(join(dir, 'meta'))
  writeFileSync(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({
      entries: [{ idx: 0, when: Date.now(), tag: '0000_probe', breakpoints: true }],
    }),
  )
  writeFileSync(join(dir, '0000_probe.sql'), sql)
  return dir
}

test('a control script outside the checkout resolves target dependencies and redacts failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-control-'))
  try {
    const script = join(dir, 'migrate.mjs')
    writeFileSync(script, readFileSync(new URL('./migrate.mjs', import.meta.url)))
    const env = { ...process.env }
    delete env.MIGRATION_DATABASE_URL
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'Migration failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dangerous migrations fail and native ignores require a same-line reason', () => {
  const dir = fixture(
    "SET lock_timeout = '5s'; SET statement_timeout = '15min';\nCREATE INDEX probe_idx ON existing_table (id);",
  )
  try {
    const file = join(dir, '0000_probe.sql')
    assert.equal(lintMigrations([file], () => {}).code, 1)
    for (const sql of [
      'ALTER TABLE existing_table ADD COLUMN required text NOT NULL;',
      'ALTER TABLE existing_table ALTER COLUMN value TYPE integer USING value::integer;',
    ]) {
      writeFileSync(file, `SET lock_timeout = '5s'; SET statement_timeout = '15min';\n${sql}`)
      assert.equal(lintMigrations([file], () => {}).code, 1)
    }
    writeFileSync(
      file,
      "SET lock_timeout = '5s'; SET statement_timeout = '15min';\n-- squawk-ignore require-concurrent-index-creation\nCREATE INDEX probe_idx ON existing_table (id);",
    )
    assert.equal(lintMigrations([file], () => {}).code, 1)
    writeFileSync(
      file,
      "SET lock_timeout = '5s'; SET statement_timeout = '15min';\n-- squawk-ignore require-concurrent-index-creation -- reason: table is empty before first deployment\nCREATE INDEX probe_idx ON existing_table (id);",
    )
    assert.equal(lintMigrations([file], () => {}).code, 0)
    assert.deepEqual(checkIgnoreReasons('-- squawk-ignore-file\nSELECT 1;'), [1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// biome-ignore lint/suspicious/noUndeclaredEnvVars: 直接运行的 Node 测试不经过 Turbo 缓存。
let localUrl = process.env.MIGRATION_DATABASE_URL
const worktreeEnv = new URL('../../.env.worktree', import.meta.url)
if (!localUrl && existsSync(worktreeEnv)) {
  localUrl = readFileSync(worktreeEnv, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('MIGRATION_DATABASE_URL='))
    ?.slice('MIGRATION_DATABASE_URL='.length)
}
const isolated =
  localUrl &&
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(localUrl).hostname) &&
  /^product_res_(?:wt_|ci)/.test(new URL(localUrl).pathname.slice(1))

test('postgres.js startup options enforce timeouts and a blocked migration fails', {
  skip: !isolated,
  timeout: 15000,
}, async () => {
  const table = `migration_lock_probe_${process.pid}`
  const journal = `migration_probe_${process.pid}`
  const owner = postgres(localUrl, { max: 1, onnotice: () => {} })
  const session = postgres(
    migrationUrl(
      `${localUrl}${localUrl.includes('?') ? '&' : '?'}options=-c%20lock_timeout%3D0%20-c%20statement_timeout%3D0&lock_timeout=0&statement_timeout=0`,
    ),
    { max: 1 },
  )
  const dir = fixture(`ALTER TABLE "${table}" ADD COLUMN added text;`)
  try {
    assert.equal((await session`SHOW lock_timeout`)[0].lock_timeout, '5s')
    assert.equal((await session`SHOW statement_timeout`)[0].statement_timeout, '15min')
    await owner.unsafe(`CREATE TABLE "${table}" (id integer)`)
    await owner.unsafe('BEGIN')
    await owner.unsafe(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`)
    const started = Date.now()
    await assert.rejects(
      runMigrations({ url: localUrl, migrationsFolder: dir, migrationsSchema: journal }),
      (error) => (error.cause ?? error).code === '55P03',
    )
    assert.ok(Date.now() - started >= 4500)
    await owner.unsafe('ROLLBACK')
    assert.equal(
      (
        await owner`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = ${table} AND column_name = 'added'`
      )[0].n,
      0,
    )
  } finally {
    await owner.unsafe('ROLLBACK')
    await owner.unsafe(`DROP TABLE IF EXISTS "${table}"`)
    await owner.unsafe(`DROP SCHEMA IF EXISTS "${journal}" CASCADE`)
    await Promise.all([owner.end(), session.end()])
    rmSync(dir, { recursive: true, force: true })
  }
})
