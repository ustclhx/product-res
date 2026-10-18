import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from '@playwright/test'
import { paymentKeys } from '../../../../scripts/local-payment-env.mjs'
import { readLocalAdminCredentials } from './local-admin.ts'

// 在导入证据 helper 前设置本地标记；不加载根 dotenv 或远程验收凭据。
if (
  process.env.STAGING_ACCEPTANCE_LOCAL !== '1' &&
  (process.env.STAGING_URL || process.env.NEON_READONLY_URL)
)
  throw new Error('Unset remote target variables before selecting the local fault config')
const worktree = parseEnv(
  readFileSync(new URL('../../../../.env.worktree', import.meta.url), 'utf8'),
)
const database = new URL(worktree.DATABASE_URL ?? 'http://missing')
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
  !/^\/product_res_wt_[a-zA-Z0-9_-]+$/.test(database.pathname)
)
  throw new Error('Local fault acceptance requires an isolated loopback worktree database')
const origin = `http://localhost:${worktree.WEB_PORT ?? '3000'}`
if (process.env.STAGING_URL && process.env.STAGING_URL !== origin)
  throw new Error('Local fault target must match this worktree port')
if (process.env.NEON_READONLY_URL) {
  const supplied = new URL(process.env.NEON_READONLY_URL)
  if (
    supplied.hostname !== database.hostname ||
    supplied.port !== database.port ||
    supplied.pathname !== database.pathname
  )
    throw new Error('Local fault database must match this worktree')
}
process.env.STAGING_ACCEPTANCE_LOCAL = '1'
process.env.STAGING_URL = origin
database.username = 'readonly'
database.password = 'readonly'
process.env.NEON_READONLY_URL = database.toString()
process.env.STAGING_ACCEPTANCE_RUN_ID ??= `local-fault-${new Date().toISOString().slice(0, 10)}`
const version = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
  cwd: new URL('../../../../', import.meta.url),
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()
process.env.STAGING_FAULT_EXPECTED_SHA = version
process.env.APP_VERSION = version
const rootPath = () => new URL('../../../../', import.meta.url).pathname
const credentials = readLocalAdminCredentials()
process.env.STAGING_ADMIN_EMAIL =
  credentials?.email ??
  process.env.STAGING_ADMIN_EMAIL ??
  `local-fault-admin-${process.env.STAGING_ACCEPTANCE_RUN_ID}@example.com`
process.env.STAGING_ADMIN_PASSWORD =
  credentials?.password ??
  process.env.STAGING_ADMIN_PASSWORD ??
  createHash('sha256')
    .update(`local-only:${rootPath()}:${process.env.STAGING_ACCEPTANCE_RUN_ID}`)
    .digest('hex')
const externalKeys = [
  ...paymentKeys,
  'SENTRY_DSN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_TOKEN',
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'FAL_KEY',
  'RESEND_API_KEY',
]
for (const key of externalKeys) process.env[key] = ''
const { default: base } = await import('./fault.config.ts')
export default defineConfig({
  ...base,
  globalSetup: './fault-local-setup.ts',
  use: { ...base.use, baseURL: origin, headless: true },
  webServer: {
    cwd: new URL('../../', import.meta.url).pathname,
    command: 'pnpm exec vite dev --config e2e/staging-acceptance/fault.local.vite.ts',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...Object.fromEntries(externalKeys.map((key) => [key, ''])),
      APP_VERSION: version,
      APP_URL: origin,
      SENTRY_ENVIRONMENT: 'staging',
      AI_FAULT_INJECTION: 'enabled',
    },
  },
})
