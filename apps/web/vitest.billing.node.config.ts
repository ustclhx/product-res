import { fileURLToPath } from 'node:url'
import { resolveTestDatabase } from '@product-res/db/test-database'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { defineConfig } from 'vitest/config'

const { appUrl, migratorUrl } =
  resolveTestDatabase('@product-res/web billing node', { required: true }) ?? {}
const valkeyUrl = readLocalEnv('TEST_VALKEY_URL')
if (!appUrl || !migratorUrl || !valkeyUrl)
  throw new Error('Node billing/admin tests require isolated database URLs and TEST_VALKEY_URL')
process.env.NODE_ADMIN_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migratorUrl
process.env.TEST_VALKEY_URL = valkeyUrl

export default defineConfig({
  resolve: {
    alias: [
      {
        find: './admin-test-resources.ts',
        replacement: fileURLToPath(new URL('./test/admin-node-resources.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/admin*.test.ts'],
    // 运行时设置与固定历史指标共享同一个隔离库，保持既有 CF 项目的串行方式。
    fileParallelism: false,
    globalSetup: ['@product-res/db/test/global-setup'],
  },
})
