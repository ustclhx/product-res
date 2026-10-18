import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'node-scheduler',
    include: ['test/node/scheduler.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
