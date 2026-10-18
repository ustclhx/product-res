import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { allDocs, allLegalPages, allPosts } from 'content-collections'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import { findLocalized, findPost, listPosts, listTags, loadDocsPage } from './content.ts'

/**
 * 博客、法律页与文档的数据（tasks.md 3.3、3.4）。内容在构建期生成，不访问数据库；
 * 页面经预渲染输出静态 HTML，客户端路由跳转时才调用这些 server function。
 *
 * 语言由调用方传入：server function 的请求地址不带语言前缀，服务端无法从 URL 得到页面语言。
 */

const { locales, defaultLocale } = templateConfig.i18n
const locale = z
  .string()
  .transform((value) => ((locales as readonly string[]).includes(value) ? value : defaultLocale))
const slug = z.string().min(1).max(200)

function requireBlog() {
  if (!templateConfig.features.blog) throw notFound()
}

export const getBlogIndex = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, tag: z.string().max(64).optional() }))
  .handler(({ data }) => {
    requireBlog()
    const now = new Date()
    const options = { locale: data.locale, defaultLocale, now }
    const posts = listPosts(allPosts, { ...options, tag: data.tag }).map(
      ({ html, ...summary }) => summary,
    )
    if (data.tag !== undefined && posts.length === 0) throw notFound()
    return { posts, tags: listTags(listPosts(allPosts, options)) }
  })

export const getBlogPost = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    requireBlog()
    const post = findPost(allPosts, { ...data, defaultLocale, now: new Date() })
    if (!post) throw notFound()
    return post
  })

export const getLegalPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    const page = findLocalized(allLegalPages, data.slug, data.locale, defaultLocale)
    if (!page) throw notFound()
    return page
  })

export const getDocsPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug: slug.optional() }))
  .handler(({ data }) => {
    const result = loadDocsPage(allDocs, {
      enabled: templateConfig.features.docs,
      slug: data.slug,
      locale: data.locale,
      defaultLocale,
    })
    if (!result) throw notFound()
    return result
  })
