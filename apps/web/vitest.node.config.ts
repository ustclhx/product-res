import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 独立 Node 项目不加载平台默认配置中的 Workers 插件。
export default defineConfig({
  root: fileURLToPath(new URL('../../packages/platform', import.meta.url)),
  test: {
    name: 'node-unit',
    environment: 'node',
    include: ['test/node.test.ts', 'test/node/request.test.ts', 'test/node/background.test.ts'],
  },
})
