import { defineConfig, type Plugin } from 'vite'
import appConfig from '../vite.config.ts'

// 与 disconnect e2e 相同：替换外部服务边界，保留真实路由、鉴权、支付服务与账本。
const localPaymentRuntime: Plugin = {
  name: 'smoke-local-payment-runtime',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './runtime.ts' && importer?.endsWith('/packages/billing/src/index.ts'))
      return new URL('./smoke-payment-runtime.ts', import.meta.url).pathname
  },
}

export default defineConfig(async (env) => {
  if (env.command !== 'serve' || process.env.STAGING_URL || process.env.CLOUDFLARE_ENV)
    throw new Error('Smoke fixtures only support local vite dev')
  const config = typeof appConfig === 'function' ? await appConfig(env) : await appConfig
  return { ...config, plugins: [localPaymentRuntime, ...(config.plugins ?? [])] }
})
