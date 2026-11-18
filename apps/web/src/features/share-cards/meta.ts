import { absoluteUrl } from '../seo/metadata.ts'
import { shareCardFontFingerprint } from './fonts.ts'
import { fnv1a } from './hash.ts'
import { type ShareCardSite, shareCardUrlLocale } from './site.ts'
import type { RegisteredShareCard } from './types.ts'

export const SHARE_CARD_WIDTH = 1200
export const SHARE_CARD_HEIGHT = 630

export interface ShareCardMeta {
  /** 当前环境 APP_URL 下的卡片绝对地址，`v` 随版式版本与展示数据变化。 */
  readonly image: string
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly title: string
  readonly description: string
  /** 可直接并入路由 head 的 meta 列表（不含 `<title>`，由页面决定标题格式）。 */
  readonly meta: ReadonlyArray<{ name?: string; property?: string; content: string }>
}

/**
 * 卡片版本 `<version>-<digest8>`；项目登记了回退字体或站点覆盖时追加 `-<指纹8>`，
 * 字体登记或站点品牌变化时地址随之变化，不同站点的缓存互不混用。两者都没有时与之前完全相同。
 */
export function shareCardVariant<T>(
  card: Pick<RegisteredShareCard<T>, 'version' | 'digest'>,
  data: T,
  site?: Pick<ShareCardSite, 'fingerprint'>,
  fontFingerprint = shareCardFontFingerprint(),
): string {
  const base = `${card.version}-${card.digest(data).slice(0, 8)}`
  const siteFingerprint = site?.fingerprint ?? ''
  if (fontFingerprint === '' && siteFingerprint === '') return base
  return `${base}-${fnv1a(`${fontFingerprint}|${siteFingerprint}`)}`
}

/**
 * 卡片相对地址：`/share-card/<type>/<token>.png?v=<variant>`（design 第 3 条）。
 * 站点覆盖生效且分享页不是默认语言时追加 `&l=<locale>`，卡片路由据此按同一语言解析站点；该语言已计入 `v`。
 */
export function shareCardImagePath<T>(
  card: RegisteredShareCard<T>,
  token: string,
  data: T,
  site?: Pick<ShareCardSite, 'fingerprint' | 'locale'>,
) {
  const version = shareCardVariant(card, data, site)
  const locale = site ? shareCardUrlLocale(site) : undefined
  return `/share-card/${encodeURIComponent(card.type)}/${encodeURIComponent(token)}.png?v=${encodeURIComponent(version)}${locale ? `&l=${encodeURIComponent(locale)}` : ''}`
}

export function buildShareCardMeta<T>(input: {
  card: RegisteredShareCard<T>
  token: string
  data: T
  appUrl: string
  /** 分享页自身地址；项目自建页面可传入自己的地址作为 og:url。 */
  pageUrl?: string | undefined
  siteName: string
  /** 当前站点；与卡片路由按请求 host 解析的结果一致，地址才不会被 302。 */
  site?: Pick<ShareCardSite, 'fingerprint' | 'locale'> | undefined
}): ShareCardMeta {
  const { card, data } = input
  const page = card.page(data)
  const image = absoluteUrl(input.appUrl, shareCardImagePath(card, input.token, data, input.site))
  const alt = card.alt(data)
  return {
    image,
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    alt,
    title: page.title,
    description: page.description,
    meta: [
      // 分享页与卡片都不进入搜索索引；卡片地址另由路由响应头 X-Robots-Tag 声明。
      { name: 'robots', content: 'noindex' },
      { name: 'description', content: page.description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: input.siteName },
      { property: 'og:title', content: page.title },
      { property: 'og:description', content: page.description },
      ...(input.pageUrl ? [{ property: 'og:url', content: input.pageUrl }] : []),
      { property: 'og:image', content: image },
      { property: 'og:image:type', content: 'image/png' },
      { property: 'og:image:width', content: String(SHARE_CARD_WIDTH) },
      { property: 'og:image:height', content: String(SHARE_CARD_HEIGHT) },
      { property: 'og:image:alt', content: alt },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: page.title },
      { name: 'twitter:description', content: page.description },
      { name: 'twitter:image', content: image },
      { name: 'twitter:image:alt', content: alt },
    ],
  }
}
