import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/node/auth-smtp.integration.node.ts'],
    fileParallelism: false,
    testTimeout: 100_000,
    hookTimeout: 20_000,
  },
})
