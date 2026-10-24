import { createRouter } from '@tanstack/react-router'
import { localeRewrite } from './features/i18n/routing.ts'
import { routeTree } from './routeTree.gen'
import { templateConfig } from './server/template-config.ts'

/** 预加载数据在导航时的复用窗口：覆盖“悬停 → 点击”的间隔，又不让列表数据旧得太久 */
export const PRELOAD_STALE_MS = 10_000

export function getRouter() {
  // 保留文件路由类型供同一源码编译；关闭模块的页面不加入运行时路由树。
  if (!templateConfig.marketing.enabled) {
    routeTree.addChildren(
      Object.values(routeTree.children ?? {}).filter(
        (route) =>
          !/^\/(?:pricing|blog|docs|legal|newsletter|waitlist|api\/(?:newsletter|waitlist)|sitemap\.xml|robots\.txt)(?:\/|$)/.test(
            route.options.path ?? '',
          ),
      ),
    )
  }
  return createRouter({
    routeTree,
    scrollRestoration: true,
    rewrite: localeRewrite,
    // 悬停 / 聚焦 / 触摸链接时预加载目标路由（含 beforeLoad 与 loader），点击后直接复用。
    // 预加载结果在 preloadStaleTime 内复用，不受各路由 staleTime: 0 影响；过期后先渲染再后台重验证。
    // router.invalidate() 会一并标记预加载与缓存的匹配失效。见 docs/frontend-navigation.md
    defaultPreload: 'intent',
    defaultPreloadStaleTime: PRELOAD_STALE_MS,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
