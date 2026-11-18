// 分享卡片的站点解析：一次部署服务多个品牌域名时，按请求 host（构建期为页面 locale / pathname）
// 决定卡片的主题、品牌行、域名与默认分享图副标题。项目在自有文件 share-cards.sites.ts 中实现
// resolveProjectShareCardSite；返回 undefined 时与单站点行为完全相同。
// 用独立的项目自有文件而不是在 share-cards.theme.ts 中可选导出：可选导出只能用命名空间导入检测，
// 命名空间对象需要打包器运行时辅助函数，会改变服务端分包（曾使 Node 构建的 icons 分包 source map 为空）。
import { templateConfig } from '../../server/template-config.ts'
import { fnv1a } from './hash.ts'
import { resolveProjectShareCardSite } from './share-cards.sites.ts'
import type { ShareCardTheme } from './types.ts'

/**
 * 与 html-attributes 的上下文对应。运行时卡片有 host 与 locale（分享页的语言，经卡片地址的 `l` 参数传给卡片路由），
 * 构建期默认分享图另有 pathname。
 */
export interface ShareCardSiteContext {
  /** 请求 URL 的 host（含非默认端口），不是转发头。 */
  readonly host?: string | undefined
  /** 已按模板配置校验的语言；运行时未知或缺省时为默认语言。 */
  readonly locale?: string | undefined
  /** 不含语言前缀的页面路径。 */
  readonly pathname?: string | undefined
}

export interface ShareCardBrand {
  readonly name: string
  /** 品牌方块中的字，默认取 name 的首字大写。 */
  readonly initial?: string | undefined
}

/** 项目解析函数的返回值；省略的字段沿用单站点默认值。 */
export interface ProjectShareCardSite {
  readonly theme?: Partial<ShareCardTheme> | undefined
  readonly brand?: ShareCardBrand | undefined
  /** 卡片右下角显示的域名。 */
  readonly host?: string | undefined
  /** 构建期默认分享图的副标题（品牌名之后），默认取首页 SEO 标题。 */
  readonly tagline?: string | undefined
}

export type ProjectShareCardSiteResolver = (
  context: ShareCardSiteContext,
) => ProjectShareCardSite | undefined

export interface ShareCardSite {
  readonly brand: ShareCardBrand
  readonly host: string
  readonly locale?: string | undefined
  readonly tagline?: string | undefined
  /** 项目站点覆盖的指纹，进入卡片地址；没有覆盖时为空串，地址与单站点相同。 */
  readonly fingerprint: string
}

function appHost(): string {
  try {
    return new URL(templateConfig.app.url).host
  } catch {
    return templateConfig.app.url
  }
}

/** 单站点默认值：模板配置的应用名与 app.url 的域名。 */
export function defaultShareCardSite(locale?: string): ShareCardSite {
  return { brand: { name: templateConfig.app.name }, host: appHost(), locale, fingerprint: '' }
}

const projectResolver = (): ProjectShareCardSiteResolver => resolveProjectShareCardSite

/** 运行时卡片的语言：只接受模板配置启用的语言，其余（含缺省与未启用多语言）一律为默认语言。 */
export function shareCardLocale(value: string | null | undefined): string {
  const { enabled, locales, defaultLocale } = templateConfig.i18n
  return enabled && value && (locales as readonly string[]).includes(value) ? value : defaultLocale
}

/**
 * 进入卡片地址 `l` 参数的语言：只在站点覆盖生效（指纹非空）且不是默认语言时给出。
 * 没有站点覆盖的项目与默认语言的卡片地址保持不变。
 */
export function shareCardUrlLocale(
  site: Pick<ShareCardSite, 'fingerprint' | 'locale'>,
): string | undefined {
  return site.fingerprint !== '' &&
    site.locale !== undefined &&
    site.locale !== templateConfig.i18n.defaultLocale
    ? site.locale
    : undefined
}

/**
 * 按请求解析站点（卡片路由、分享页与 shareCardMeta 共用）。站点覆盖返回了 `host`（项目声明的规范域名）时，
 * 分享页与卡片的绝对地址使用该域名（协议沿用 APP_URL）；否则仍用 APP_URL。
 * 从不使用请求的原始 Host：www 变体、预览与 workers.dev 域名不进入对外元数据，也不信任任意 Host 头。
 * `locale`：分享页传入页面语言，卡片路由传入地址的 `l` 参数；经 shareCardLocale 校验，未知或缺省为默认语言。
 */
export function resolveRequestShareCardSite(
  requestUrl: string,
  appUrl: string,
  resolver: ProjectShareCardSiteResolver | undefined = projectResolver(),
  locale?: string | null,
): { site: ShareCardSite; themeOverride: Partial<ShareCardTheme>; origin: string } {
  const { host } = new URL(requestUrl)
  const { canonicalHost, ...resolved } = resolveShareCardSite(
    { host, locale: shareCardLocale(locale) },
    resolver,
  )
  const origin = canonicalHost ? `${new URL(appUrl).protocol}//${canonicalHost}` : appUrl
  return { ...resolved, origin }
}

/** 裸主机名（可带端口）：不含协议、路径、查询、用户信息，且 URL 解析后保持不变。 */
export function isBareHost(value: string): boolean {
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value)) return false
  try {
    return new URL(`https://${value}`).host === value.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 解析站点覆盖。只返回主题覆盖 `themeOverride`，由渲染方交给 theme.ts 的 resolveShareCardTheme 叠加：
 * 本模块被分享页与元数据的服务端模块静态导入，不能把主题基线（@product-res/ui/share-card-theme）带进这些分包，
 * 否则服务端分包合并方式改变（曾使 Node 构建的 icons 分包只剩再导出、source map 为空）。
 * 覆盖的 `host` 不是裸主机名时整个覆盖视为无效，按单站点处理
 * （本模块也被 /dev/ui 客户端导入，不写服务端日志；单测覆盖该行为）。
 * `canonicalHost` 只在覆盖声明了合法 `host` 时给出，供绝对地址使用。
 */
export function resolveShareCardSite(
  context: ShareCardSiteContext = {},
  resolver: ProjectShareCardSiteResolver | undefined = projectResolver(),
): {
  site: ShareCardSite
  themeOverride: Partial<ShareCardTheme>
  canonicalHost?: string | undefined
} {
  const fallback = defaultShareCardSite(context.locale)
  const override = resolver?.(context)
  if (!override) return { site: fallback, themeOverride: {} }
  if (override.host !== undefined && !isBareHost(override.host)) {
    return { site: fallback, themeOverride: {} }
  }
  const canonicalHost = override.host?.toLowerCase()
  const site: ShareCardSite = {
    brand: override.brand ?? fallback.brand,
    host: canonicalHost ?? fallback.host,
    locale: context.locale,
    tagline: override.tagline,
    // 只对覆盖内容取指纹：同一站点得到同一地址，不同站点的卡片缓存互不混用。
    // 非默认语言另计入指纹：项目版式可按 site.locale 输出不同文字，各语言的卡片不能共用缓存；
    // 默认语言不计入，0.4.x 已发出的卡片地址不变。
    fingerprint: fnv1a(
      JSON.stringify([
        override.theme ?? null,
        override.brand ?? null,
        canonicalHost ?? null,
        override.tagline ?? null,
        ...(context.locale !== undefined && context.locale !== templateConfig.i18n.defaultLocale
          ? [context.locale]
          : []),
      ]),
    ),
  }
  return { site, themeOverride: { ...override.theme }, canonicalHost }
}
