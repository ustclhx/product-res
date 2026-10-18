import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 恢复演练校验（add-cloud-production-neon 4.2）：对恢复出的临时目标只读执行检查，
 * 规则与 deploy/selfhost/backup/restore.py 一致（积分不变量同 reconcileWorkspaceCredits）。
 * 连接串只经环境变量 RESTORE_DATABASE_URL 传入，拆成 PG* 环境变量交给 psql，不进命令参数。
 * 用法：RESTORE_DATABASE_URL=... node scripts/production/verify-restore.mjs [--roles]
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export const keyTables = ['user', 'organization', 'payment', 'credit_ledger', 'ai_task']

export function migrationCount(journal) {
  const entries = JSON.parse(journal).entries
  if (!Array.isArray(entries)) throw new Error('migration journal has no entries')
  return entries.length
}

export function buildChecks({ expectedMigrations, roles = false }) {
  const checks = [
    {
      name: 'pg17',
      sql: "SELECT current_setting('server_version_num')::int BETWEEN 170000 AND 179999",
    },
    {
      name: 'migrations',
      sql: `SELECT count(*) = ${Number(expectedMigrations)} FROM drizzle.__drizzle_migrations`,
    },
    {
      name: 'business_tables',
      sql: "SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public')",
    },
    {
      name: 'constraints',
      sql: 'SELECT NOT EXISTS(SELECT 1 FROM pg_constraint WHERE NOT convalidated)',
    },
    {
      name: 'credits_balance',
      sql: `SELECT NOT EXISTS (
        SELECT 1 FROM (SELECT workspace_id FROM credit_ledger UNION SELECT workspace_id FROM credit_grant
          UNION SELECT workspace_id FROM credit_hold UNION SELECT workspace_id FROM credit_debt) w
        WHERE (SELECT coalesce(sum(delta),0) FROM credit_ledger WHERE workspace_id=w.workspace_id)
          <> (SELECT coalesce(sum(remaining),0) FROM credit_grant WHERE workspace_id=w.workspace_id AND status='active')
           + (SELECT coalesce(sum(amount),0) FROM credit_hold WHERE workspace_id=w.workspace_id AND status='held')
           - (SELECT coalesce(sum(amount),0) FROM credit_debt WHERE workspace_id=w.workspace_id))`,
    },
  ]
  if (roles) {
    // Neon 时间点分支保留原角色；逻辑备份恢复到新库时不检查（角色属于集群而非 dump）
    checks.push(
      {
        name: 'roles',
        sql: "SELECT count(*)=3 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) FROM pg_roles WHERE rolname IN ('app','migrator','readonly')",
      },
      {
        name: 'role_permissions',
        sql: "SELECT has_schema_privilege('migrator','public','CREATE') AND NOT has_schema_privilege('app','public','CREATE') AND NOT has_schema_privilege('readonly','public','CREATE')",
      },
    )
  }
  return checks
}

export function pgEnv(url) {
  const parsed = new URL(url)
  const env = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
  }
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return env
}

function query(sql, env) {
  const result = spawnSync(
    process.env.PSQL || 'psql',
    ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    {
      input: `BEGIN READ ONLY;\n${sql};\nCOMMIT;\n`,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  )
  // 不输出 stderr 原文，避免带出主机或角色信息
  if (result.status !== 0) return { ok: false, value: null }
  return { ok: true, value: result.stdout.trim() }
}

export function verifyRestore({ url, roles, write = console.log, run = query }) {
  const env = pgEnv(url)
  const journal = readFileSync(
    resolve(repoRoot, 'packages/db/migrations/meta/_journal.json'),
    'utf8',
  )
  const checks = buildChecks({ expectedMigrations: migrationCount(journal), roles })
  let failed = 0
  for (const check of checks) {
    const { ok, value } = run(check.sql, env)
    const pass = ok && value === 't'
    if (!pass) failed += 1
    write(JSON.stringify({ check: check.name, ok: pass }))
  }
  for (const table of keyTables) {
    const { ok, value } = run(`SELECT count(*) FROM public."${table}"`, env)
    write(JSON.stringify({ table, rows: ok ? Number(value) : null }))
  }
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.RESTORE_DATABASE_URL
  if (!url) {
    console.error('RESTORE_DATABASE_URL is required')
    process.exitCode = 1
  } else {
    process.exitCode = verifyRestore({ url, roles: process.argv.includes('--roles') })
  }
}
