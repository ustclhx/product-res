import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@product-res/web ai node', { required: true }) ?? {}
if (!appUrl || !migratorUrl) throw new Error('Node AI tests require isolated database URLs')
process.env.NODE_AI_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/ai-node/*.node.ts'],
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
