import { defineConfig } from 'vitest/config'

// 真实项目探针必须显式运行，默认测试与开发不会读取或发送真实 DSN。
if (!process.env.SENTRY_DSN) throw new Error('Explicit SENTRY_DSN required for local probe')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/sentry-local/probe.node.ts'],
    testTimeout: 30_000,
  },
})
