import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

if (process.env.STAGING_URL)
  throw new Error('Disconnect e2e only supports the isolated local server')

export default defineConfig({
  ...base,
  testMatch: 'ai-chat-disconnect.spec.ts',
  testIgnore: '**/staging/**',
  webServer: {
    ...(Array.isArray(base.webServer) ? base.webServer[0] : base.webServer),
    command:
      'pnpm exec vite dev --config e2e/ai-chat-disconnect.vite.ts > /tmp/chat-disconnect-e2e.log 2>&1',
    reuseExistingServer: false,
  },
})
