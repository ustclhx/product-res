// 生成 src/routeTree.gen.ts（已 gitignore，见 docs/09-parallel-plan.md §3）。
// typecheck 不经过 vite dev / build，需先生成路由树。TanStack Start 插件在 configResolved
// 阶段生成，且会追加 Start 专属的 Register 声明，因此直接解析 Vite 配置，而不是用 tsr CLI。
import { resolveConfig } from 'vite'

await resolveConfig({ configFile: new URL('../vite.config.ts', import.meta.url).pathname }, 'build')
