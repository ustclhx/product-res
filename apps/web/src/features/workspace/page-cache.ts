/**
 * 工作空间页数据的客户端短缓存（docs/frontend-navigation.md）。
 *
 * `/app/$slug` 的 beforeLoad 在每次导航（含预加载、`router.invalidate()`）都会重跑，
 * 不缓存时每次切 tab 都要先等一次 getWorkspacePage 往返，子路由 loader 才能开始。
 * 这里的开通检查只是 UX 门，真正的授权由各 Server Function 的 `withWorkspace` 强制，
 * 因此在浏览器内按 slug 缓存一个短 TTL 不削弱安全：
 * - 只缓存已开通（active）结果；待开通、出错与重定向都不缓存，管理员开通后刷新即可进入；
 * - 只保留一个 slug，切换空间时旧条目失效；整页刷新、登出（整页跳转）时内存自然清空；
 * - 服务端（SSR）不缓存，模块级状态不能跨请求、跨用户共享。
 */

export const WORKSPACE_PAGE_TTL_MS = 60_000

type Entry<Page> = { slug: string; promise: Promise<Page>; expiresAt: number }

export type WorkspacePageCache<Page> = {
  /** 命中未过期条目时复用；`fresh` 时总是重新获取并刷新缓存 */
  load(slug: string, fetchPage: () => Promise<Page>, options?: { fresh?: boolean }): Promise<Page>
  /** 用已有数据（SSR 水合结果）填充缓存；已有条目时不覆盖，避免反复延长 TTL */
  prime(slug: string, page: Page): void
  clear(): void
}

export function createWorkspacePageCache<Page>({
  ttlMs = WORKSPACE_PAGE_TTL_MS,
  cacheable,
  enabled = () => true,
  now = Date.now,
}: {
  ttlMs?: number
  cacheable: (page: Page) => boolean
  enabled?: () => boolean
  now?: () => number
}): WorkspacePageCache<Page> {
  let entry: Entry<Page> | null = null
  const valid = (slug: string) =>
    entry !== null && entry.slug === slug && entry.expiresAt > now() ? entry : null

  return {
    load(slug, fetchPage, options) {
      if (!enabled()) return fetchPage()
      const hit = options?.fresh ? null : valid(slug)
      if (hit) return hit.promise
      // 进行中的请求也放进缓存：悬停预加载与随后的导航共用同一次请求
      const promise = fetchPage()
      const current: Entry<Page> = { slug, promise, expiresAt: now() + ttlMs }
      entry = current
      promise.then(
        (page) => {
          if (entry === current && !cacheable(page)) entry = null
        },
        () => {
          if (entry === current) entry = null
        },
      )
      return promise
    },
    prime(slug, page) {
      if (!enabled() || valid(slug) || !cacheable(page)) return
      entry = { slug, promise: Promise.resolve(page), expiresAt: now() + ttlMs }
    },
    clear() {
      entry = null
    },
  }
}
