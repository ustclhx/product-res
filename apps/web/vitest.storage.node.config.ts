import { defineConfig } from 'vitest/config'

if (
  !process.env.NODE_STORAGE_DATABASE_URL ||
  !process.env.TEST_VALKEY_URL ||
  !process.env.S3_ENDPOINT
)
  throw new Error('Run scripts/test-node-storage.mjs for isolated storage resources')

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/node/storage-http.node.ts',
      'src/node/sentry-http.node.ts',
      'src/features/files/http.test.ts',
    ],
    globalSetup: ['@product-res/db/test/global-setup'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
