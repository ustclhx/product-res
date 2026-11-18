import type { Plugin } from 'vite'

/**
 * 客户端构建把 zod schema 的构造调用（`z.object(...)`、`z.string().optional()` 等）视为无副作用：
 * TanStack Start 在客户端删掉 server function 的 validator 调用后，模块顶层的 schema 常量不再被引用，
 * 但 zod 调用默认被当作有副作用而保留，整套 zod（约 35KB gzip）因此随路由树进入首页水合。
 * 标记为纯函数后未被引用的 schema 随之摇掉；客户端真正用到的（表单、validateSearch）照常保留。
 * 只作用于 client 环境；服务端构建不变。
 * 注意：只为副作用而写、结果不被引用的 zod 调用（模块顶层的 `z.config(z.locales.xx())`、`schema.register(registry, …)`）
 * 在客户端构建中会被删掉；需要在浏览器生效时，把它放进会被调用的函数里（如表单初始化），或改用 globalThis 写入。
 */
export function clientPureSchemas(names: readonly string[] = ['z']): Plugin {
  return {
    name: 'saas:client-pure-schemas',
    configEnvironment(name) {
      if (name !== 'client') return
      return { build: { rolldownOptions: { treeshake: { manualPureFunctions: [...names] } } } }
    },
  }
}
