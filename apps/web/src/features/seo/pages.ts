import { templateConfig } from '../../server/template-config.ts'
import { listPosts, listTags, localizedEntries } from '../marketing/content.ts'
import type { SeoPage } from './metadata.ts'
import { localizedPath, staticPage } from './metadata.ts'

interface Post {
  slug: string
  locale: string
  title: string
  summary: string
  date: string
  tags: string[]
  draft: boolean
  cover?: string | undefined
}
interface Page {
  slug: string
  locale: string
  title: string
  description: string
}

/** 地图与 OG 共用公开页面清单，始终排除草稿、未来文章和关闭的功能。 */
export function publicPages(
  content: { posts: readonly Post[]; legal: readonly Page[]; docs: readonly Page[] },
  now = new Date(),
  config = templateConfig,
): SeoPage[] {
  if (!config.marketing.enabled) return []
  const locales = config.i18n.enabled ? config.i18n.locales : [config.i18n.defaultLocale]
  return locales.flatMap((locale) => {
    const { defaultLocale } = config.i18n
    const pages = ['/', ...(config.billing.enabled ? ['/pricing'] : [])].map((path) =>
      staticPage(path, locale),
    )
    if (config.features.newsletter) pages.push(staticPage('/newsletter', locale))
    if (config.features.waitlist) pages.push(staticPage('/waitlist', locale))
    if (config.features.blog) {
      pages.push(staticPage('/blog', locale))
      const posts = listPosts(
        content.posts.filter((post) => !post.draft),
        { locale, defaultLocale, now },
      )
      pages.push(
        ...posts.map((post) => ({
          path: `/blog/${encodeURIComponent(post.slug)}`,
          locale,
          title: post.title,
          description: post.summary,
          date: post.date,
          cover: post.cover,
        })),
      )
      pages.push(
        ...listTags(posts).map((tag) => ({
          path: `/blog/tags/${encodeURIComponent(tag)}`,
          locale,
          title: locale === 'zh' ? `标签“${tag}”下的文章` : `Posts tagged “${tag}”`,
          description: `${staticPage('/blog', locale).description} · ${tag}`,
        })),
      )
    }
    pages.push(
      ...localizedEntries(content.legal, locale, defaultLocale).map((page) => ({
        ...page,
        locale,
        path: `/legal/${encodeURIComponent(page.slug)}`,
      })),
    )
    if (config.features.docs) {
      pages.push(staticPage('/docs', locale))
      pages.push(
        ...localizedEntries(content.docs, locale, defaultLocale).map((page) => ({
          ...page,
          locale,
          path: `/docs/${encodeURIComponent(page.slug)}`,
        })),
      )
    }
    return pages
  })
}

export function findPublicPage(pages: readonly SeoPage[], path: string): SeoPage | undefined {
  return pages.find((page) => localizedPath(page.path, page.locale) === path)
}
