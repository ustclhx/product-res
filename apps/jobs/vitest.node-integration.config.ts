import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

process.env.TEST_JOB_DATABASE_URL ??= readLocalEnv(
  'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE',
)
process.env.MIGRATION_DATABASE_URL ??= readLocalEnv('MIGRATION_DATABASE_URL')

export default defineConfig({
  test: {
    include: [
      'test/node-production.integration.test.ts',
      'test/node-wire.integration.test.ts',
      'test/node-datasync.integration.test.ts',
      'test/node-stores.integration.test.ts',
      'test/node-transfer.integration.test.ts',
      ...(process.env.JOBS_SMTP_PORT && process.env.JOBS_SMTP_CONTROL
        ? ['test/node-smtp.integration.test.ts', 'test/node-observer-shutdown.integration.test.ts']
        : []),
    ],
    fileParallelism: false,
    globalSetup: ['test/node-jobs-setup.ts'],
    testTimeout: 15_000,
  },
})
