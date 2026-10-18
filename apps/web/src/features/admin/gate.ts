import type { WebRuntime } from '../../server/runtime.ts'
import { isAdminNotFound, requireAdmin } from './guard.ts'

/**
 * `/admin/**` 页面请求在交给 TanStack Start 之前的守卫（tasks.md 5.1）。
 *
 * 路由自身的 `beforeLoad` 守卫虽然也返回 404，但路由器在执行它之前已经匹配到 `/admin` 路由，
 * SSR 输出的 head 与序列化的匹配状态里会出现该路由，与真正不存在的页面不同。这里把非 admin 的请求
 * 改写到一个不存在的路径，由应用渲染普通的 404 页面，响应与任何不存在的页面一致。
 *
 * 末尾带 `/` 的路径不在这里处理：路由器对所有路径都先 307 到去掉 `/` 的地址（不执行守卫），
 * 改写反而会让 `/admin/` 与其他路径表现不同。
 */

export const ADMIN_PATH = '/admin'
/** 保证不存在的路径（不要为它新增路由） */
export const NOT_FOUND_PATH = '/__not-found'

export function isGatedAdminPath(pathname: string): boolean {
  if (pathname.length > 1 && pathname.endsWith('/')) return false
  return pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)
}

export async function gateAdminRequest(request: Request, runtime: WebRuntime): Promise<Request> {
  const url = new URL(request.url)
  if (!isGatedAdminPath(url.pathname)) return request
  const { db, auth } = runtime
  try {
    await requireAdmin({ auth, db, headers: request.headers })
    return request
  } catch (error) {
    if (!isAdminNotFound(error)) throw error
    return new Request(new URL(NOT_FOUND_PATH, url), request)
  }
}
