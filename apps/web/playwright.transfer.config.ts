import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

if (process.env.STAGING_URL || process.env.PRODUCTION_URL || process.env.CLOUDFLARE_ENV)
  throw new Error('Transfer e2e only supports the isolated local server')

export default defineConfig({
  ...base,
  testMatch: 'workspace-transfer.transfer.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { ...base.use, trace: 'on', screenshot: 'only-on-failure' },
  webServer: {
    ...(Array.isArray(base.webServer) ? base.webServer[0] : base.webServer),
    command: 'pnpm exec vite dev --config e2e/transfer.vite.ts > /tmp/transfer-e2e.log 2>&1',
    reuseExistingServer: false,
  },
})
