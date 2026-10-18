import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          exclude: ['src/node/test/**'],
          environment: 'node',
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
        test: { name: 'workerd', include: ['test/workerd/**/*.test.ts'] },
      },
    ],
  },
})
