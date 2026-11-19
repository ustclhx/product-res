import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { resolveTestDatabase } from './test-database.ts'

const { appUrl, migratorUrl: migrationUrl } =
  resolveTestDatabase('@product-res/db node', { required: true }) ?? {}
if (!appUrl || !migrationUrl) throw new Error('Node DB tests require both database URLs')
process.env.NODE_DB_TEST_URL = appUrl
process.env.CREDITS_TEST_DATABASE_URL = appUrl
process.env.MIGRATION_DATABASE_URL = migrationUrl

// 复用原业务断言，只替换各 CF 测试的连接输入；不加载或仿真 Worker 运行时。
const sharedTests = [
  'audit-log-grants',
  'billing-credits',
  'costing',
  'insight',
  'schema',
  'scoped',
  'selection',
  'setting',
  'validation',
].map((name) => fileURLToPath(new URL(`./test/${name}.test.ts`, import.meta.url)))
const fixturePath = fileURLToPath(new URL('./test/node/env.ts', import.meta.url))
export default defineConfig({
  plugins: [
    {
      name: 'node-db-test-input',
      enforce: 'pre',
      transform(code, id) {
        if (!sharedTests.includes(id)) return
        return code.replace(
          "import { env } from 'cloudflare:workers'",
          `import { env } from '${fixturePath}'`,
        )
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['test/*.test.ts', 'test/node/*.test.ts', '../credits/test/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/node/setup.ts'],
    fileParallelism: false,
  },
})
