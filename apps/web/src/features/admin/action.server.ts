import { notFound } from '@tanstack/react-router'
import {
  AdminAccessRevokedError,
  type AdminActionContext,
  type AdminActionScope,
  runAdminAction,
  runDelegatedAdminAction,
} from './action.ts'

// 后台写操作包装的 server function 绑定（add-admin-console tasks.md 1.1，逻辑见 action.ts）。
// 只能在 server function 的 handler 内引用：*.functions.ts 会被客户端导入，handler 之外的
// 引用会把 @product-res/db（postgres）带进浏览器 bundle。

function rethrowRevoked(error: unknown): never {
  if (error instanceof AdminAccessRevokedError) throw notFound()
  throw error
}

/**
 * 后台写操作的 server function handler（tasks.md 1.1，见 action.ts）：
 * `.middleware([adminMiddleware]).handler(adminAction('name', async ({ tx, audit, data }) => ...))`。
 * 写事务内发现角色已失效时与中间件一样返回 404；业务错误原样抛出。
 */
export function adminAction<TData, TResult>(
  name: string,
  handler: (scope: AdminActionScope & { readonly data: TData }) => Promise<TResult>,
) {
  return ({ context, data }: { context: AdminActionContext; data: TData }) =>
    runAdminAction(context, name, (scope) => handler({ ...scope, data })).catch(rethrowRevoked)
}

/** 在 handler 内部使用的同一包装（需要在提交后继续做远程调用的操作，如回调重放） */
export function withAdminAction<T>(
  context: AdminActionContext,
  name: string,
  handler: (scope: AdminActionScope) => Promise<T>,
): Promise<T> {
  return runAdminAction(context, name, handler).catch(rethrowRevoked)
}

/** 业务函数自己管理事务并写审计的操作（action.ts `runDelegatedAdminAction`） */
export function withDelegatedAdminAction<T>(
  context: AdminActionContext,
  handler: Parameters<typeof runDelegatedAdminAction<T>>[1],
): Promise<T> {
  return runDelegatedAdminAction(context, handler).catch(rethrowRevoked)
}
