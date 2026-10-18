import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/node/test/smtp.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 5000,
  },
})
