import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { syncLocalPaymentEnv } from '../../../scripts/local-payment-env.mjs'
import { sitePlugins } from '../scripts/vite-shared.ts'

const repoRoot = new URL('../../../', import.meta.url).pathname
const worktree = loadEnv('worktree', repoRoot, '')
const port = Number(worktree.WEB_PORT)
const workflow = {
  binding: 'WORKSPACE_TRANSFER_WORKFLOW',
  name: 'workspace-transfer-e2e',
  class_name: 'WorkspaceTransferWorkflow',
}

// 只在独立 e2e 配置的编译图中开启；根配置和生产产物仍默认关闭。
const enableTransfer: Plugin = {
  name: 'transfer-e2e-enable',
  enforce: 'pre',
  transform(code, id) {
    if (id === `${repoRoot}template.config.ts`)
      return code.replace('dataTransfer: false,', 'dataTransfer: true,')
  },
}

export default defineConfig(({ command }) => {
  if (
    command !== 'serve' ||
    process.env.STAGING_URL ||
    process.env.PRODUCTION_URL ||
    process.env.CLOUDFLARE_ENV ||
    !worktree.DATABASE_URL?.includes('/product_res_wt_')
  )
    throw new Error('Transfer e2e requires local dev and an isolated worktree database')
  for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED']) {
    const key = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`
    process.env[key] = worktree[key]
  }
  // 沿用离线 suite 的空支付环境，把两边 .dev.vars 的管理区块同步为空值。
  syncLocalPaymentEnv(new URL('../', import.meta.url))
  syncLocalPaymentEnv(new URL('../../jobs/', import.meta.url))
  return {
    server: { port, strictPort: true },
    define: { __APP_VERSION__: JSON.stringify('transfer-e2e') },
    plugins: [
      enableTransfer,
      cloudflare({
        remoteBindings: false,
        inspectorPort: Number(worktree.WEB_INSPECTOR_PORT),
        persistState: { path: '.wrangler/transfer-e2e' },
        viteEnvironment: { name: 'ssr' },
        config: {
          vars: { APP_URL: `http://localhost:${port}` },
          workflows: [{ ...workflow, script_name: 'product-res-jobs' }],
        },
        auxiliaryWorkers: [
          {
            configPath: new URL('../../jobs/wrangler.jsonc', import.meta.url).pathname,
            config: { workflows: [workflow] },
            devOnly: true,
          },
        ],
      }),
      ...sitePlugins(),
    ],
  }
})
