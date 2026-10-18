import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

if (process.env.STAGING_URL || process.env.E2E_REAL_TURNSTILE === '1' || process.env.CLOUDFLARE_ENV)
  throw new Error('Smoke e2e only supports the isolated local server and Turnstile stub')

export default defineConfig({
  ...base,
  testMatch: 'smoke.spec.ts',
  testIgnore: '**/staging/**',
  globalSetup: './e2e/smoke-setup.ts',
  timeout: 60_000,
  globalTimeout: 240_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off', serviceWorkers: 'block' },
  webServer: {
    ...(Array.isArray(base.webServer) ? base.webServer[0] : base.webServer),
    command: 'pnpm exec vite dev --config e2e/smoke.vite.ts > /tmp/ci-e2e-smoke.log 2>&1',
    env: {
      ...(Array.isArray(base.webServer) ? base.webServer[0]?.env : base.webServer?.env),
      WRANGLER_SEND_METRICS: 'false',
    },
    reuseExistingServer: false,
  },
})
