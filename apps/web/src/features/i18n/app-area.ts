/**
 * 应用区路径前缀：不加语言前缀，语言取自用户设置（design.md 决策 3、Non-Goals）。
 * vite.config.ts 据此配置 Paraglide 的 routeStrategies，因此这里不引用任何运行时模块。
 */
export const APP_AREA_PREFIXES = ['/app', '/account', '/admin', '/api'] as const

export function isAppAreaPath(pathname: string): boolean {
  return APP_AREA_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
