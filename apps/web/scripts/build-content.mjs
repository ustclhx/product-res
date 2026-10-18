// 生成 .content-collections/generated（已 gitignore）。vite dev / build 由 content-collections 插件生成，
// typecheck 与单元测试不经过它们，与 compile-messages.mjs 一样单独生成。
import { createBuilder } from '@content-collections/core'

const builder = await createBuilder(new URL('../content-collections.ts', import.meta.url).pathname)
await builder.build()
