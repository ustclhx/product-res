import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { ogImages } from './scripts/og-images.ts'
import { pricingSnapshotPlugin } from './scripts/pricing-snapshot.ts'
import { sitePlugins } from './scripts/vite-shared.ts'

const version =
  process.env.APP_VERSION ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('APP_VERSION must be a full git SHA')

// Nitro 默认 buildDir 下的 Vite SSR service 中间产物；其 map 已指向 TypeScript 并含源码。
const serviceOutput = fileURLToPath(
  new URL('./node_modules/.nitro/vite/services/', import.meta.url),
)

/**
 * Nitro 第二遍 rolldown 把 service 中间 JS 当作普通输入，不读取其 map，
 * 最终 `_ssr/*.mjs.map` 只指向会被丢弃的中间文件。load 时交出中间 map，由 rolldown 串接到源码。
 */
const serviceInputMaps = {
  name: 'saas:service-input-maps',
  async load(id: string) {
    if (!id.startsWith(serviceOutput) || !id.endsWith('.js')) return null
    const map = await readFile(`${id}.map`, 'utf8').catch(() => null)
    if (!map) return null
    return { code: await readFile(id, 'utf8'), map }
  },
}

export default defineConfig({
  // Node 构建不读取部署 dotenv 或数据库，生产校验只在直接启动产物时执行。
  envDir: false,
  build: { sourcemap: 'hidden' },
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    ogImages(),
    pricingSnapshotPlugin(),
    ...sitePlugins('server.node.ts'),
    nitro({
      preset: 'node_server',
      sourcemap: true,
      // bootstrap 独立编译，SDK 仍需被 trace 到可复制的生产产物。
      traceDeps: ['@sentry/node'],
      entry: fileURLToPath(new URL('./src/node/http.ts', import.meta.url)),
      serverEntry: false,
      // 默认 sourcemapMinify 会删除 sourcesContent，并清空来源全在 node_modules（含上述中间产物）的 mappings。
      experimental: { asyncContext: true, sourcemapMinify: false },
      // workspace 源码必须编译，第三方/原生依赖由 Nitro trace 到独立产物。
      noExternals: [/^@product-res\//],
      // B 的 barrel 导出尚未装配，保留外置边界并移除未使用的引擎导入。
      rolldownConfig: {
        plugins: [serviceInputMaps],
        external: ['@dbos-inc/dbos-sdk', 'pg'],
        treeshake: { moduleSideEffects: (id) => !['@dbos-inc/dbos-sdk', 'pg'].includes(id) },
      },
    }),
  ],
})
