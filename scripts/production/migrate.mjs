import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 使用 db 工作区的同一份驱动与迁移器，避免根目录再安装一套依赖。
const require = createRequire(join(process.cwd(), 'packages/db/package.json'))
const postgres = require('postgres')
const { drizzle } = require('drizzle-orm/postgres-js')
const { migrate } = require('drizzle-orm/postgres-js/migrator')

export function migrationUrl(value) {
  if (!value) throw new Error('MIGRATION_DATABASE_URL is required')
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Postgres URL required')
  // URL 中的直接 GUC 比 options 更晚生效；删掉可覆盖安全上限的参数。
  url.searchParams.delete('lock_timeout')
  url.searchParams.delete('statement_timeout')
  const existing = url.searchParams.get('options') ?? ''
  url.searchParams.set(
    'options',
    `${existing} -c lock_timeout=5s -c statement_timeout=15min`.trim(),
  )
  return url.toString()
}

export async function runMigrations({
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: 发布入口直接执行，不经过 Turbo 缓存。
  url = process.env.MIGRATION_DATABASE_URL,
  migrationsFolder = join(process.cwd(), 'packages/db/migrations'),
  migrationsSchema = 'drizzle',
} = {}) {
  const client = postgres(migrationUrl(url), { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder, migrationsSchema })
  } finally {
    await client.end()
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await runMigrations()
    console.log('Migrations completed (lock_timeout=5s, statement_timeout=15min)')
  } catch (error) {
    // 驱动错误可能携带 SQL 与连接信息；发布日志只输出 SQLSTATE。
    const code = (error.cause ?? error).code
    console.error(
      `Migration failed${/^[A-Z0-9]{5}$/.test(code ?? '') ? ` (SQLSTATE ${code})` : ''}`,
    )
    process.exitCode = 1
  }
}
