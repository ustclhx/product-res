import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/files-node/*.node.ts', 'src/features/files/http.test.ts'],
  },
})
