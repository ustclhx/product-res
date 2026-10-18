import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // 交互测试在 happy-dom 中渲染；SSR 测试在文件头用 `@vitest-environment node` 切换
    environment: 'happy-dom',
    // Node 25+ 的内置 storage 会遮蔽 happy-dom；测试始终使用浏览器环境的 storage。
    execArgv: ['--no-experimental-webstorage'],
  },
})
