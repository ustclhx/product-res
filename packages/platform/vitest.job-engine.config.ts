import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'node-job-engine',
    include: [
      'test/node/job-queue.integration.test.ts',
      'test/node/job-engine.integration.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 1_100_000,
    hookTimeout: 60_000,
  },
})
