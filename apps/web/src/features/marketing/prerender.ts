/**
 * 预渲染范围（openspec add-marketing-i18n-seo design.md 决策 2）：首页、博客、法律页与文档页在构建期
 * 生成静态 HTML，访客请求不经过数据库（specs/marketing-site「营销页预渲染」）。
 * 定价页（/pricing）读取套餐数据，由 tasks.md 3.2 单独处理，不在这里预渲染。
 *
 * vite.config.ts 据此配置 TanStack Start 的 prerender.filter，因此这里不引用任何运行时模块。
 */
export const PRERENDERED_PREFIXES = ['/blog', '/legal', '/docs'] as const

/** 去掉语言前缀后判断是否预渲染；`locales` 为模板配置中的全部语言 */
export function isPrerenderedPath(path: string, locales: readonly string[]): boolean {
  const pathname = (path.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/'
  const [, first = '', ...rest] = pathname.split('/')
  const delocalized = locales.includes(first)
    ? `/${rest.join('/')}`.replace(/\/$/, '') || '/'
    : pathname
  if (delocalized === '/') return true
  return PRERENDERED_PREFIXES.some(
    (prefix) => delocalized === prefix || delocalized.startsWith(`${prefix}/`),
  )
}

/** 预渲染的入口页面：各语言首页，其余页面由链接爬取得到 */
export function prerenderEntryPages(
  locales: readonly string[],
  defaultLocale: string,
): { path: string }[] {
  return locales.map((locale) => ({ path: locale === defaultLocale ? '/' : `/${locale}` }))
}
