// `node:async_hooks` 的最小声明：Workers（nodejs_compat）与 Node 都提供 AsyncLocalStorage，
// 但 web / jobs 的 tsconfig 不引入 @types/node（与 workers-types 的全局类型冲突），这里只声明日志上下文用到的部分。
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: () => R): R
  }
}
