import type { AnyRouteMatch } from '@tanstack/react-router'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from '../i18n/app-area.ts'

export interface SeoPage {
  path: string
  title: string
  description: string
  locale: string
  cover?: string | undefined
  date?: string | undefined
}

const { defaultLocale, enabled } = templateConfig.i18n
const locales = enabled ? templateConfig.i18n.locales : [defaultLocale]
export function localizedPath(path: string, locale: string): string {
  const clean = path.replace(/\/+$/, '') || '/'
  return !enabled || locale === defaultLocale ? clean : `/${locale}${clean === '/' ? '' : clean}`
}

export function absoluteUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl).href
}

export function alternateLinks(
  appUrl: string,
  path: string,
  languages: readonly string[] = locales,
) {
  return [...languages, 'x-default'].map((language) => ({
    rel: 'alternate',
    hrefLang: language,
    href: absoluteUrl(
      appUrl,
      localizedPath(path, language === 'x-default' ? defaultLocale : language),
    ),
  }))
}

export function staticPage(path: string, locale: string): SeoPage {
  const zh = locale === 'zh'
  const copy: Record<string, [string, string]> = {
    '/': zh
      ? ['AI 工作空间', '在一个工作空间中使用 AI 对话、创作与团队协作。']
      : [
          'Your AI workspace',
          'AI conversations, creation and team collaboration in one workspace.',
        ],
    '/pricing': zh
      ? ['定价与套餐', '比较订阅套餐与积分包，选择适合你的 AI 工作空间。']
      : ['Pricing and plans', 'Compare subscriptions and credit packs for your AI workspace.'],
    '/blog': zh
      ? ['博客', '阅读产品更新、实践指南与创作技巧。']
      : ['Blog', 'Product updates, practical guides and creation tips.'],
    '/docs': zh
      ? ['文档', '查阅工作空间的入门、配置和内容指南。']
      : ['Documentation', 'Getting started, configuration and content guides for your workspace.'],
    '/newsletter': zh
      ? ['订阅通讯', '订阅邮件通讯，获取最新产品消息。']
      : ['Newsletter', 'Subscribe to receive the latest product news.'],
    '/waitlist': zh
      ? ['加入候补名单', '登记候补名单，第一时间收到产品开放通知。']
      : ['Join the waitlist', 'Join the waitlist to hear when the product is ready.'],
  }
  const [title, description] = copy[path] ?? [path, path]
  return { path, title, description, locale }
}

export function privateMeta(path: string) {
  return isAppAreaPath(path) ? [{ name: 'robots', content: 'noindex, nofollow' }] : []
}

/** URL 由根 loader 读取运行时 APP_URL，下发客户端后也用于路由切换。 */
export function originFromMatches(
  matches: readonly Pick<AnyRouteMatch, 'loaderData' | 'routeId'>[],
): string {
  const root = matches.find((match) => match.routeId === '__root__')
  if (!root) throw new Error('Root SEO origin is unavailable')
  return (root.loaderData as { appUrl: string }).appUrl
}

export function ogImagePath(page: Pick<SeoPage, 'path' | 'locale'>): string {
  return `/og/${page.locale}${page.path === '/' ? '/index' : page.path}.png`
}

export function pageHead(page: SeoPage, appUrl: string, structuredData: readonly unknown[] = []) {
  const url = absoluteUrl(appUrl, localizedPath(page.path, page.locale))
  const title = `${page.title} | ${templateConfig.app.name}`
  const image = page.cover
    ? absoluteUrl(appUrl, page.cover)
    : absoluteUrl(appUrl, ogImagePath(page))
  return {
    meta: [
      { title },
      { name: 'description', content: page.description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: page.description },
      { property: 'og:url', content: url },
      { property: 'og:site_name', content: templateConfig.app.name },
      { property: 'og:type', content: page.date ? 'article' : 'website' },
      { property: 'og:locale', content: page.locale },
      { property: 'og:image', content: image },
      { property: 'og:image:alt', content: title },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: page.description },
      { name: 'twitter:image', content: image },
      { name: 'twitter:image:alt', content: title },
    ],
    links: [{ rel: 'canonical', href: url }, ...alternateLinks(appUrl, page.path)],
    scripts: structuredData.map((data) => ({
      type: 'application/ld+json',
      children: JSON.stringify(data).replace(/</g, '\\u003c'),
    })),
  }
}
