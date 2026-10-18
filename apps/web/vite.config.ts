import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, loadEnv } from 'vite'
import { syncLocalPaymentEnv } from '../../scripts/local-payment-env.mjs'
import { ogImages } from './scripts/og-images.ts'
import { prerenderEnvFallback } from './scripts/prerender-env.ts'
import { pricingSnapshotPlugin } from './scripts/pricing-snapshot.ts'
import { sitePlugins } from './scripts/vite-shared.ts'

const repoRoot = new URL('../../', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}
const appVersion = (() => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || pkg.version
    )
  } catch {
    // 源码归档或无 git 的构建环境仍可构建，包版本作为最后回退。
    return pkg.version
  }
})()

// Orca worktree 的端口写在仓库根目录的 .env.worktree（docs/09-parallel-plan.md §2）；
// 文件不存在时（主 checkout）使用默认端口。
const worktreeEnv = loadEnv('worktree', repoRoot, '')
const port = Number(worktreeEnv.WEB_PORT ?? 3000)
const inspectorPort = Number(worktreeEnv.WEB_INSPECTOR_PORT ?? 9229)

// Hyperdrive 本地连接：wrangler 优先读取这两个环境变量，其次是 wrangler.jsonc 中的 localConnectionString。
for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED']) {
  const name = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`
  const value = worktreeEnv[name]
  if (value && !process.env[name]) process.env[name] = value
}

export default defineConfig(({ command }) => {
  // 本地 dev 时把根目录 .env.local 的五项测试支付配置同步到 .dev.vars 管理区块（#26）
  if (command === 'serve') syncLocalPaymentEnv(new URL('./', import.meta.url))
  return {
    build: { sourcemap: 'hidden' },
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [
      ogImages(),
      // SSR 由 workerd 执行：Cloudflare 插件接管 Vite 的 ssr 环境
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        // Workers AI 无本地模拟；开发与预览禁用远程绑定，避免启动时要求登录或真实推理。
        remoteBindings: false,
        inspectorPort,
        // 本地开发时 Better Auth 的 baseURL 跟随实际端口（worktree 各不相同）；构建产物沿用 wrangler.jsonc
        ...((command === 'serve' || process.env.APP_URL) && {
          config: { vars: { APP_URL: process.env.APP_URL ?? `http://localhost:${port}` } },
        }),
      }),
      // 没有 .dev.vars 时（CI）预渲染用的 preview 改用 .dev.vars.example 的假值通过启动校验
      prerenderEnvFallback(),
      pricingSnapshotPlugin(
        process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED,
      ),
      ...sitePlugins(),
    ],
  }
})
