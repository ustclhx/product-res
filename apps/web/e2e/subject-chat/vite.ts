import { defineConfig, type Plugin } from 'vite'
import appConfig from '../../vite.config.ts'

// 嵌入式对话 e2e（add-ai-chat-components 5.2）的 dev 配置：登记一个测试对象类型，并让临时上下文页渲染嵌入的
// SubjectChat。其余路由、鉴权、新建对象对话与计费保持原实现；对话流在页面内替换 fetch。
const harness: Plugin = {
  name: 'subject-chat-e2e',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer) return
    if (source === './subject-providers.ts' && importer.includes('/src/features/ai/'))
      return new URL('./providers.ts', import.meta.url).pathname
    if (source.endsWith('features/ai/subject-chat.tsx') && importer.includes('/chat/context.tsx'))
      return new URL('./harness.tsx', import.meta.url).pathname
  },
}

export default defineConfig(async (env) => {
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return { ...config, plugins: [harness, ...(config.plugins ?? [])] }
})
