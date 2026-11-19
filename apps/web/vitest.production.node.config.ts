import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@product-res/web production node', { required: true }) ?? {}
const valkeyUrl = process.env.TEST_VALKEY_URL
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Production smoke requires isolated PG and Valkey')
process.env.NODE_PRODUCTION_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/fixtures/production-node/*.node.ts'],
    globalSetup: ['@product-res/db/test/global-setup'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
})
