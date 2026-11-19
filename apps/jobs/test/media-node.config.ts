import { fileURLToPath } from 'node:url'
import { resolveTestDatabase } from '@product-res/db/test-database'
import { defineConfig } from 'vitest/config'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@product-res/jobs media node', { required: true }) ?? {}
if (!appUrl || !migratorUrl) throw new Error('Media tests require isolated worktree database')
process.env.TEST_JOB_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./fixtures/media-node-env.ts', import.meta.url)),
      '@product-res/storage/cloudflare': fileURLToPath(
        new URL('./fixtures/media-node-storage.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'test/media-workflow.test.ts',
      'test/media-settlement.test.ts',
      'test/media-hold-sweep.test.ts',
    ],
    fileParallelism: false,
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
