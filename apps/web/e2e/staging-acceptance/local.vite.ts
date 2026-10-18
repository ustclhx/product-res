import { defineConfig, type Plugin } from 'vite'
import appConfig from '../../vite.config.ts'

const helper = new URL('./local-media.ts', import.meta.url).pathname
const mocks: Plugin = {
  name: 'acceptance-local-only',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './model.ts' && importer?.endsWith('/packages/ai/src/text/index.ts'))
      return new URL('./local-text-model.ts', import.meta.url).pathname
  },
  transform(code, id) {
    if (this.environment.name !== 'ssr') return
    if (/\/src\/routes\/api\/ai\/tasks(?:\.ts|\/.*\.ts)$/.test(id)) {
      return `import { localWorkflow, localProvider } from ${JSON.stringify(helper)}\n${code}`
        .replace('    env,', "    env: { ...env, MEDIA_WEBHOOK_SECRET: 'local-fixture' },")
        .replace(
          'workflow: env.AI_MEDIA_WORKFLOW,',
          'workflow: localWorkflow(db, env.FILES) as unknown as typeof env.AI_MEDIA_WORKFLOW, providerFactory: localProvider,',
        )
    }
    if (id.endsWith('/src/routes/api/files/$id.ts'))
      return code.replace(
        "import { handleFileDownload } from '../../../features/files/http.ts'",
        `import { localDownload as handleFileDownload } from ${JSON.stringify(helper)}`,
      )
  },
}
export default defineConfig(async (env) => {
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return { ...config, plugins: [mocks, ...(config.plugins ?? [])] }
})
