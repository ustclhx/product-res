import { createWorkspacePageCache } from './page-cache.ts'
import { getWorkspacePage } from './workspace.functions.ts'

type WorkspacePageResult = Awaited<ReturnType<typeof getWorkspacePage>>

const cache = createWorkspacePageCache<WorkspacePageResult>({
  cacheable: (page) => page.activation === 'active',
  // SSR 每个请求照常获取；只有浏览器内的导航复用
  enabled: () => typeof window !== 'undefined',
})

/** `/app/$slug` beforeLoad 使用：浏览器内短缓存，SSR 与 `fresh` 时直接获取 */
export function loadWorkspacePage(slug: string, options?: { fresh?: boolean }) {
  return cache.load(slug, () => getWorkspacePage({ data: { slug } }), options)
}

/** SSR 水合后用首屏数据填充缓存，首次客户端导航不再重取 */
export function primeWorkspacePage(slug: string, page: WorkspacePageResult) {
  cache.prime(slug, page)
}

/** 会改变工作台布局数据（只读状态、席位、成员等）的写操作在 `router.invalidate()` 前调用 */
export function clearWorkspacePageCache() {
  cache.clear()
}
