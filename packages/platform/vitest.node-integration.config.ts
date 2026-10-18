import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'node-integration', include: ['test/node/cache.integration.test.ts'] },
})
