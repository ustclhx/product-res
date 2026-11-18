import { resolveTestDatabase } from '@product-res/db/test-database'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@product-res/auth node', { required: true }) ?? {}
const valkeyUrl = readLocalEnv('TEST_VALKEY_URL')
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Node auth tests require isolated database URLs and TEST_VALKEY_URL')
process.env.NODE_AUTH_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl
process.env.TEST_VALKEY_URL = valkeyUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/node/*.test.ts'],
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
