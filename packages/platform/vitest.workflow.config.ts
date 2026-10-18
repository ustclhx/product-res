import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'node-workflow',
    include: ['test/node/workflow.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
