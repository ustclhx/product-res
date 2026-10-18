// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: 一次性迁移不经过 Turbo，没有缓存。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
// 部署入口不属于 workspace package，直接复用 shared 的结构化脱敏日志。
import { log } from '../../packages/shared/src/log.ts'

function report(event, ok) {
  if (ok) log.info(event)
  else log.error(event)
}

try {
  if (process.env.MIGRATION_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL_FILE)
    throw new Error('migration config')
  const databaseUrl = readFileSync(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8').replace(
    /\n$/,
    '',
  )
  const url = new URL(databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username !== 'migrator' ||
    url.hostname !== 'postgres' ||
    url.searchParams.get('sslmode') !== 'verify-full'
  )
    throw new Error('migration role or TLS')
  const env = { ...process.env, MIGRATION_DATABASE_URL: databaseUrl }
  for (const [pkg, command] of [
    ['@product-res/db', 'db:migrate'],
    ['@product-res/platform', 'dbos:migrate'],
  ]) {
    // CLI/驱动原文可能包含连接配置，边界只输出固定事件。
    const result = spawnSync('pnpm', ['--filter', pkg, command], {
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    if (result.error || result.status !== 0) throw new Error('migration failed')
    report(`selfhost.${command}.completed`, true)
  }
  writeFileSync('/tmp/migrate-completed', 'ok\n')
} catch {
  report('selfhost.migration.failed', false)
  process.exitCode = 1
}
