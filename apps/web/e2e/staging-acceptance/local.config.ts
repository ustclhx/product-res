import { randomBytes } from 'node:crypto'
import { defineConfig } from '@playwright/test'
import { loadEnv } from 'vite'
import { paymentKeys } from '../../../../scripts/local-payment-env.mjs'
import { readLocalAdminCredentials } from './local-admin.ts'
import base from './playwright.config.ts'

// 只有显式选择这份配置才能产生本地账号/种子，不允许读取或覆盖 staging 连接。
if (
  !process.env.STAGING_ACCEPTANCE_LOCAL &&
  (process.env.STAGING_URL || process.env.NEON_READONLY_URL)
)
  throw new Error('Unset remote target variables before selecting the local config')
const env = loadEnv('worktree', new URL('../../../../', import.meta.url).pathname, '')
const db = new URL(env.DATABASE_URL ?? 'http://missing')
if (
  !['localhost', '127.0.0.1'].includes(db.hostname) ||
  !db.pathname.startsWith('/product_res_wt_')
)
  throw new Error('Local acceptance requires an isolated worktree database')
db.username = 'readonly'
db.password = 'readonly'
process.env.STAGING_ACCEPTANCE_LOCAL = '1'
process.env.STAGING_URL = `http://localhost:${env.WEB_PORT ?? 3000}`
process.env.NEON_READONLY_URL = db.toString()
process.env.STAGING_ACCEPTANCE_RUN_ID ??= `local-${Date.now()}`
const localAdmin = readLocalAdminCredentials()
if (localAdmin) {
  process.env.STAGING_ADMIN_EMAIL = localAdmin.email
  process.env.STAGING_ADMIN_PASSWORD = localAdmin.password
}
for (const account of ['ADMIN', 'USER', 'TEST_USER']) {
  process.env[`STAGING_${account}_EMAIL`] ??=
    `acceptance-${account.toLowerCase()}-${process.env.STAGING_ACCEPTANCE_RUN_ID}@example.com`
  process.env[`STAGING_${account}_PASSWORD`] ??= randomBytes(24).toString('hex')
}
export default defineConfig({
  ...base,
  globalSetup: './local-setup.ts',
  use: { ...base.use, baseURL: process.env.STAGING_URL },
  webServer: {
    cwd: new URL('../../', import.meta.url).pathname,
    command:
      'pnpm exec vite dev --config e2e/staging-acceptance/local.vite.ts > /tmp/staging-acceptance-local.log 2>&1',
    url: `${process.env.STAGING_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: Object.fromEntries(paymentKeys.map((key) => [key, ''])),
  },
})
