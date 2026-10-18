// 生成 src/paraglide（已 gitignore）。vite dev / build 由 Paraglide 插件编译，
// typecheck 不经过它们，因此与 generate-route-tree.mjs 一样解析 Vite 配置后调用插件的编译函数。
import { resolveConfig } from 'vite'

const config = await resolveConfig(
  { configFile: new URL('../vite.config.ts', import.meta.url).pathname },
  'build',
)
await config.plugins.find((plugin) => plugin.name === 'saas:i18n-messages')?.api.compile()
