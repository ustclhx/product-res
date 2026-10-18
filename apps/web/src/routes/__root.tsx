import { themeInitScript } from '@product-res/ui'
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ImpersonationBanner } from '../features/admin/impersonation-banner.tsx'
import { getAnnouncement } from '../features/admin/settings-announcement.functions.ts'
import { AnnouncementBanner } from '../features/admin/settings-announcement-banner.tsx'
import { ProductAnalytics } from '../features/analytics/analytics.tsx'
import { analyticsHeadScripts } from '../features/analytics/head.ts'
import { LanguageControls } from '../features/i18n/language-controls.tsx'
import { privateMeta } from '../features/seo/metadata.ts'
import { getSafeImpersonation, getSeoOrigin } from '../features/seo/origin.functions.ts'
import { ThemeToggle } from '../features/theme/theme-toggle.tsx'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'
import appCss from '../styles/app.css?url'

export const Route = createRootRoute({
  loader: async () => {
    const [impersonation, announcement, appUrl] = await Promise.all([
      getSafeImpersonation(),
      getAnnouncement(),
      getSeoOrigin(),
    ])
    return { impersonation, announcement, appUrl }
  },
  staleTime: Infinity,
  head: ({ matches }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'product-res' },
      ...privateMeta(matches.at(-1)?.pathname ?? '/'),
    ],
    // 全局样式（Tailwind + @product-res/ui 主题），SSR 输出的 <head> 中直接引用，避免首屏无样式闪烁
    links: [{ rel: 'stylesheet', href: appCss }],
    // 首屏前按偏好（未设置时跟随系统）给 <html> 设置 dark 类：<head> 内同步执行，避免刷新时先浅后深的闪烁
    scripts: [
      { children: themeInitScript() },
      ...analyticsHeadScripts(matches.at(-1)?.pathname ?? '/', templateConfig),
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { impersonation, announcement } = Route.useLoaderData()
  // 后台侧栏与认证页脚自带控件，避免浮动控件遮挡正文。
  const hasInlineControls = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId.startsWith('/(auth)/')) ||
      /^\/admin(\/|$)/.test(state.location.pathname),
  })
  return (
    <RootDocument floatingControls={!hasInlineControls}>
      <ProductAnalytics />
      <ImpersonationBanner viewer={impersonation} />
      <AnnouncementBanner initial={announcement} />
      {templateConfig.i18n.enabled && !hasInlineControls && <LanguageControls />}
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({
  children,
  floatingControls,
}: Readonly<{ children: ReactNode; floatingControls: boolean }>) {
  return (
    // 主题类名由下方内联脚本在水合前写到 <html> 上，与服务端输出不一致属预期
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {floatingControls && <ThemeToggle className="fixed right-4 bottom-4" />}
        <Scripts />
      </body>
    </html>
  )
}
