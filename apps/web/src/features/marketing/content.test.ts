import { describe, expect, it } from 'vitest'
import {
  type DocLike,
  findPost,
  listPosts,
  listTags,
  loadDocsPage,
  type PostLike,
  searchDocs,
} from './content.ts'

const now = new Date('2026-10-07T00:00:00Z')
const post = (locale: string, slug: string, date: string, tags: string[] = []): PostLike => ({
  locale,
  slug,
  date,
  tags,
})
const posts = [
  post('en', 'welcome', '2026-09-01', ['guide']),
  post('zh', 'welcome', '2026-09-01', ['guide']),
  post('en', 'english-only', '2026-09-20', ['news']),
  post('en', 'scheduled', '2099-01-01', ['news']),
]

describe('博客（tasks.md 3.3）', () => {
  it('列表按发布时间倒序，定时发布的文章到期前不出现', () => {
    const list = listPosts(posts, { locale: 'en', defaultLocale: 'en', now })
    expect(list.map((p) => p.slug)).toEqual(['english-only', 'welcome'])
    expect(findPost(posts, { slug: 'scheduled', locale: 'en', defaultLocale: 'en', now })).toBe(
      undefined,
    )
    const later = new Date('2099-01-02T00:00:00Z')
    expect(
      findPost(posts, { slug: 'scheduled', locale: 'en', defaultLocale: 'en', now: later }),
    ).toBeDefined()
  })

  it('优先当前语言的版本，缺少翻译时回退到默认语言', () => {
    const list = listPosts(posts, { locale: 'zh', defaultLocale: 'en', now })
    expect(list.map((p) => `${p.locale}/${p.slug}`)).toEqual(['en/english-only', 'zh/welcome'])
    expect(
      findPost(posts, { slug: 'english-only', locale: 'zh', defaultLocale: 'en', now })?.locale,
    ).toBe('en')
  })

  it('按标签筛选，标签列表只来自已发布文章', () => {
    const options = { locale: 'en', defaultLocale: 'en', now }
    expect(listPosts(posts, { ...options, tag: 'news' }).map((p) => p.slug)).toEqual([
      'english-only',
    ])
    expect(listTags(listPosts(posts, options))).toEqual(['guide', 'news'])
  })
})

const doc = (locale: string, slug: string, section: string, order: number): DocLike => ({
  locale,
  slug,
  title: `${slug} title`,
  description: `${slug} description`,
  section,
  order,
  searchText: `${slug} body text about configuration`,
})
const docs = [
  doc('en', 'configuration', 'Basics', 2),
  doc('en', 'getting-started', 'Basics', 1),
  doc('en', 'deploy', 'Guides', 3),
  doc('zh', 'getting-started', '基础', 1),
]

describe('文档站（tasks.md 3.4）', () => {
  const base = { locale: 'en', defaultLocale: 'en' }

  it('features.docs 关闭时任何文档路由都没有数据（路由返回 404）', () => {
    expect(loadDocsPage(docs, { ...base, enabled: false })).toBeNull()
    expect(loadDocsPage(docs, { ...base, enabled: false, slug: 'getting-started' })).toBeNull()
  })

  it('features.docs 打开时：首页为导航第一篇，侧边导航按分组与顺序排列，不存在的页面 404', () => {
    const index = loadDocsPage(docs, { ...base, enabled: true })
    expect(index?.page.slug).toBe('getting-started')
    expect(index?.nav).toEqual([
      {
        title: 'Basics',
        items: [
          { slug: 'getting-started', title: 'getting-started title' },
          { slug: 'configuration', title: 'configuration title' },
        ],
      },
      { title: 'Guides', items: [{ slug: 'deploy', title: 'deploy title' }] },
    ])
    expect(loadDocsPage(docs, { ...base, enabled: true, slug: 'deploy' })?.page.slug).toBe('deploy')
    expect(loadDocsPage(docs, { ...base, enabled: true, slug: 'missing' })).toBeNull()
  })

  it('构建期搜索索引：所有词都命中才返回，标题命中优先', () => {
    const result = loadDocsPage(docs, { ...base, enabled: true })
    expect(result?.searchIndex).toHaveLength(3)
    const index = result?.searchIndex ?? []
    expect(searchDocs(index, 'configuration').map((e) => e.slug)[0]).toBe('configuration')
    expect(searchDocs(index, 'deploy body').map((e) => e.slug)).toEqual(['deploy'])
    expect(searchDocs(index, 'nothing-matches')).toEqual([])
    expect(searchDocs(index, '  ')).toEqual([])
  })

  it('其他语言使用该语言的文档，缺失的页面回退到默认语言', () => {
    const zh = loadDocsPage(docs, { locale: 'zh', defaultLocale: 'en', enabled: true })
    expect(zh?.page.locale).toBe('zh')
    expect(zh?.nav.map((s) => s.title)).toEqual(['基础', 'Basics', 'Guides'])
  })
})
