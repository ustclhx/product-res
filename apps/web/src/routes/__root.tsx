import { themeInitScript } from '@product-res/ui'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { ImpersonationBanner } from '../features/admin/impersonation-banner.tsx'
import { getAnnouncement } from '../features/admin/settings-announcement.functions.ts'
import { AnnouncementBanner } from '../features/admin/settings-announcement-banner.tsx'
import { ProductAnalytics } from '../features/analytics/analytics.tsx'
import { analyticsHeadScripts } from '../features/analytics/head.ts'
import { LanguageControls } from '../features/i18n/language-controls.tsx'
import { LOCALE_COOKIE_MAX_AGE, PREFERENCE_COOKIE } from '../features/i18n/preference.ts'
import { localeSuggestionScript, SUGGESTABLE_LOCALES } from '../features/i18n/suggestion.ts'
import { privateMeta } from '../features/seo/metadata.ts'
import {
  getPlausibleSite,
  getSafeImpersonation,
  getSeoOrigin,
} from '../features/seo/origin.functions.ts'
import { getHtmlAttributes } from '../features/theme/html-attributes.isomorphic.ts'
import { RootDocument } from '../features/theme/root-document.tsx'
import { SiteSettings } from '../features/theme/site-settings.tsx'
import { baseLocale, cookieName, locales } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'
import appCss from '../styles/app.css?url'

export const Route = createRootRoute({
  beforeLoad: ({ location }) => ({
    htmlAttributes: getHtmlAttributes(location.pathname),
  }),
  loader: async () => {
    const [impersonation, announcement, appUrl, plausible] = await Promise.all([
      getSafeImpersonation(),
      getAnnouncement(),
      getSeoOrigin(),
      getPlausibleSite(),
    ])
    return { impersonation, announcement, appUrl, plausible }
  },
  staleTime: Infinity,
  head: ({ matches, loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'product-res' },
      ...privateMeta(matches.at(-1)?.pathname ?? '/'),
    ],
    // 全局样式（Tailwind + @product-res/ui 主题），SSR 输出的 <head> 中直接引用，避免首屏无样式闪烁
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
    ],
    // 首屏前按偏好（未设置时跟随系统）给 <html> 设置 dark 类：<head> 内同步执行，避免刷新时先浅后深的闪烁
    scripts: [
      { children: themeInitScript() },
      // 语言建议同样在首帧前决定，横幅随首帧出现在最终位置，不在水合后把整页下推（suggestion.ts）
      ...(templateConfig.i18n.enabled
        ? [
            {
              children: localeSuggestionScript({
                baseLocale,
                locales,
                preferenceCookie: PREFERENCE_COOKIE,
                localeCookie: cookieName,
                cookieMaxAge: LOCALE_COOKIE_MAX_AGE,
                suggestableLocales: SUGGESTABLE_LOCALES,
              }),
            },
          ]
        : []),
      ...analyticsHeadScripts(
        matches.at(-1)?.pathname ?? '/',
        templateConfig,
        loaderData?.plausible,
      ),
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { impersonation, announcement } = Route.useLoaderData()
  const { htmlAttributes } = Route.useRouteContext()
  // 后台侧栏、认证页脚与选品工作台账号菜单（WorkbenchShell）自带控件，路由也可用
  // staticData.floatingControls = false 声明不需要，避免浮动控件遮挡正文。
  // 工作台固定使用项目外壳，不按 ui.appLayout 判断。
  const hasInlineControls = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId.startsWith('/(auth)/') ||
          match.staticData.floatingControls === false ||
          // 只在工作台壳实际渲染时；空间不存在或出错时显示浮动控件
          (match.routeId === '/app/$slug' &&
            match.status !== 'notFound' &&
            match.status !== 'error'),
      ) || /^\/admin(\/|$)/.test(state.location.pathname),
  })
  return (
    <RootDocument floatingControls={!hasInlineControls} htmlAttributes={htmlAttributes}>
      <ProductAnalytics />
      <ImpersonationBanner viewer={impersonation} />
      <AnnouncementBanner initial={announcement} />
      {templateConfig.i18n.enabled && !hasInlineControls && <LanguageControls />}
      <Outlet />
      {/* 手机端没有站点页脚的公开页：设置行放在页面末尾，底部留 80px 给右下悬浮按钮；有页脚时由页脚渲染，这里隐藏 */}
      {!hasInlineControls && (
        <SiteSettings className="border-t px-4 pt-4 pb-20 md:hidden print:hidden [body:has([data-site-footer])_&]:hidden" />
      )}
    </RootDocument>
  )
}
