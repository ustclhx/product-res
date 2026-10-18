/**
 * 博客、法律页与文档的查询规则（openspec add-marketing-i18n-seo tasks.md 3.3、3.4）。
 * 只处理 content-collections 生成的数据，不引用生成模块本身，便于单元测试。
 *
 * - 内容按 `<locale>/<slug>` 组织；某语言没有对应版本时回退到默认语言的版本。
 * - 草稿在生产构建中已被跳过（content-collections.ts），这里只按发布时间过滤定时发布的文章。
 */

interface Localized {
  readonly locale: string
  readonly slug: string
}

export interface PostLike extends Localized {
  readonly date: string
  readonly tags: readonly string[]
}

export interface DocLike extends Localized {
  readonly title: string
  readonly description: string
  readonly section: string
  readonly order: number
  readonly searchText: string
}

/** 发布时间已到（定时发布的文章在到期前不出现） */
export function isPublished(post: Pick<PostLike, 'date'>, now: Date): boolean {
  return new Date(post.date).getTime() <= now.getTime()
}

/** 当前语言的条目，缺失的 slug 用默认语言的版本补齐 */
export function localizedEntries<T extends Localized>(
  entries: readonly T[],
  locale: string,
  defaultLocale: string,
): T[] {
  const bySlug = new Map<string, T>()
  for (const entry of entries) if (entry.locale === defaultLocale) bySlug.set(entry.slug, entry)
  for (const entry of entries) if (entry.locale === locale) bySlug.set(entry.slug, entry)
  return [...bySlug.values()]
}

export function findLocalized<T extends Localized>(
  entries: readonly T[],
  slug: string,
  locale: string,
  defaultLocale: string,
): T | undefined {
  return (
    entries.find((entry) => entry.slug === slug && entry.locale === locale) ??
    entries.find((entry) => entry.slug === slug && entry.locale === defaultLocale)
  )
}

/** 博客列表：已发布、可按标签筛选，按发布时间倒序 */
export function listPosts<T extends PostLike>(
  posts: readonly T[],
  options: { locale: string; defaultLocale: string; now: Date; tag?: string | undefined },
): T[] {
  return localizedEntries(posts, options.locale, options.defaultLocale)
    .filter((post) => isPublished(post, options.now))
    .filter((post) => options.tag === undefined || post.tags.includes(options.tag))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

/** 已发布文章中出现过的标签，按名称排序 */
export function listTags(posts: readonly PostLike[]): string[] {
  return [...new Set(posts.flatMap((post) => post.tags))].sort()
}

export function findPost<T extends PostLike>(
  posts: readonly T[],
  options: { slug: string; locale: string; defaultLocale: string; now: Date },
): T | undefined {
  const post = findLocalized(posts, options.slug, options.locale, options.defaultLocale)
  return post && isPublished(post, options.now) ? post : undefined
}

export interface DocsNavSection {
  readonly title: string
  readonly items: readonly { slug: string; title: string }[]
}

/** 文档侧边导航：文档按 order（全站顺序）、标题排序，分组按其第一篇出现的位置排列 */
export function docsNav(docs: readonly DocLike[]): DocsNavSection[] {
  const sorted = [...docs].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  const sections = new Map<string, { slug: string; title: string }[]>()
  for (const doc of sorted) {
    const items = sections.get(doc.section) ?? []
    items.push({ slug: doc.slug, title: doc.title })
    sections.set(doc.section, items)
  }
  return [...sections].map(([title, items]) => ({ title, items }))
}

export interface DocsSearchEntry {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly text: string
}

/** 构建期生成的搜索索引（随文档页的数据下发，客户端搜索） */
export function docsSearchIndex(docs: readonly DocLike[]): DocsSearchEntry[] {
  return docs.map(({ slug, title, description, searchText }) => ({
    slug,
    title,
    description,
    text: searchText,
  }))
}

/** 所有词都出现在标题、描述或正文中即命中；标题命中的排在前面 */
export function searchDocs(index: readonly DocsSearchEntry[], query: string): DocsSearchEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const haystack = (entry: DocsSearchEntry) =>
    `${entry.title} ${entry.description} ${entry.text}`.toLowerCase()
  const titleHits = (entry: DocsSearchEntry) =>
    terms.filter((term) => entry.title.toLowerCase().includes(term)).length
  return index
    .filter((entry) => terms.every((term) => haystack(entry).includes(term)))
    .sort((a, b) => titleHits(b) - titleHits(a))
}

/**
 * 文档页数据（tasks.md 3.4）：`features.docs` 关闭时返回 null（路由返回 404），
 * 未指定 slug 时取侧边导航的第一篇。
 */
export function loadDocsPage<T extends DocLike>(
  docs: readonly T[],
  options: { enabled: boolean; slug?: string | undefined; locale: string; defaultLocale: string },
): { page: T; nav: DocsNavSection[]; searchIndex: DocsSearchEntry[] } | null {
  if (!options.enabled) return null
  const entries = localizedEntries(docs, options.locale, options.defaultLocale)
  const nav = docsNav(entries)
  const slug = options.slug ?? nav[0]?.items[0]?.slug
  const page = slug === undefined ? undefined : entries.find((doc) => doc.slug === slug)
  if (!page) return null
  return { page, nav, searchIndex: docsSearchIndex(entries) }
}
