import { defineConfig, type Plugin } from 'vite'
import appConfig from '../vite.config.ts'

// 只在这份测试配置中替换工厂，真实路由、鉴权、预扣、waitUntil 和结算保持原实现。
const mockFactory: Plugin = {
  name: 'disconnect-e2e-model',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './model.ts' && importer?.endsWith('/packages/ai/src/text/index.ts'))
      return new URL('./ai-chat-disconnect.model.ts', import.meta.url).pathname
  },
}

export default defineConfig(async (env) => {
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return { ...config, plugins: [mockFactory, ...(config.plugins ?? [])] }
})
