/**
 * 仅限开发环境（`vite dev`）的接口。`import.meta.env.DEV` 在构建时被替换为常量，
 * 生产构建中这些路由一律返回 404，传入的处理函数不会执行。
 */
export function devOnly(handler: () => Promise<Response>): Promise<Response> {
  if (!import.meta.env.DEV) return Promise.resolve(new Response('Not Found', { status: 404 }))
  return handler()
}
