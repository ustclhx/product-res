/**
 * postgres.js 3.4.9 的 workerd polyfill（cf/polyfills.js）在连接失败或断开时，socket 内部的
 * promise（如 `writer.ready`）会以 socket 错误（「Stream was cancelled.」「Network connection lost.」等）
 * reject 且无人处理。这发生在驱动内部、调用方无法捕获；查询本身的错误仍会正常传给调用方。
 *
 * 供 vitest 的 `onUnhandledError` 使用：只忽略栈顶来自该 polyfill 的未处理 rejection。
 */
export function isPostgresSocketRejection(error: unknown): boolean {
  const stack = (error as { stack?: unknown } | null)?.stack
  if (typeof stack !== 'string') return false
  const firstFrame = stack.split('\n').find((line) => line.trimStart().startsWith('at '))
  return firstFrame?.includes('postgres/cf/polyfills.js') ?? false
}
