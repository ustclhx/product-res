// 内容方案（openspec add-marketing-i18n-seo design.md 决策 1）：仓库中的 MDX 文件经 content-collections
// 校验 frontmatter 并生成类型化数据，由 `content-collections` 别名引用（vite.config.ts 的插件生成）。
//
// 目录约定：content/<集合>/<locale>/<slug>.mdx，locale 与 slug 由文件路径得到。
// MDX 在构建期渲染为 HTML（Worker 中不允许 `new Function` 执行 MDX 编译结果），页面直接输出 HTML。
import { defineCollection, defineConfig, type Meta } from '@content-collections/core'
import { compileMDX } from '@content-collections/mdx'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'
import templateConfig from '../../template.config.ts'

/**
 * 是否保留草稿：`vite dev` 中显示草稿便于预览，生产构建（NODE_ENV=production）直接跳过，
 * 草稿不会进入构建产物（specs/marketing-site「博客」）。CONTENT_DRAFTS=1 可在构建中强制保留。
 */
const includeDrafts = process.env.CONTENT_DRAFTS === '1' || process.env.NODE_ENV !== 'production'

/** 由 `<locale>/<slug...>` 形式的路径得到语言与 slug */
function localeAndSlug(meta: Meta): { locale: string; slug: string } {
  const [locale = '', ...rest] = meta.path.split('/')
  return { locale, slug: rest.join('/') }
}

type CompileContext = Parameters<typeof compileMDX>[0]

/** MDX → 静态 HTML（构建期在 Node 中执行） */
async function renderMdx(context: CompileContext, document: { _meta: Meta; content: string }) {
  const code = await compileMDX(context, document)
  const scope = { React, ReactDOM, _jsx_runtime: jsxRuntime }
  const Component = new Function(...Object.keys(scope), code)(...Object.values(scope)).default
  return renderToStaticMarkup(React.createElement(Component))
}

/** 搜索索引用的纯文本：去掉标签并合并空白 */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 法律页与文档中的 `{{key}}` 占位符按模板配置替换（站点名称与地址、支持邮箱、可申请退款的天数），
 * 新站点改配置即可，不必逐页修改文案。
 */
const legalPlaceholders: Record<string, string> = {
  appName: templateConfig.app.name,
  appUrl: templateConfig.app.url.replace(/\/+$/, ''),
  supportEmail: templateConfig.app.supportEmail,
  refundWindowDays: String(templateConfig.billing.refundWindowDays),
}

export function fillPlaceholders(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => legalPlaceholders[key] ?? match)
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/)

const posts = defineCollection({
  name: 'posts',
  directory: 'content/blog',
  include: '*/**/*.mdx',
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    /** 发布时间（ISO 日期或日期时间）；晚于当前时间的文章在到期前不出现 */
    date: isoDate,
    cover: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    content: z.string(),
  }),
  transform: async (document, context) => {
    if (!templateConfig.features.blog) return context.skip('features.blog=false')
    if (document.draft && !includeDrafts) return context.skip('draft')
    const { content, ...data } = document
    return { ...data, ...localeAndSlug(document._meta), html: await renderMdx(context, document) }
  },
})

const legalPages = defineCollection({
  name: 'legalPages',
  directory: 'content/legal',
  include: '*/*.mdx',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    updatedAt: isoDate,
    content: z.string(),
  }),
  transform: async (document, context) => {
    const { content, ...data } = document
    return {
      ...data,
      ...localeAndSlug(document._meta),
      title: fillPlaceholders(data.title),
      description: fillPlaceholders(data.description),
      html: await renderMdx(context, { ...document, content: fillPlaceholders(content) }),
    }
  },
})

const docs = defineCollection({
  name: 'docs',
  directory: 'content/docs',
  include: '*/**/*.mdx',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** 侧边导航中的分组；order 为全站顺序，分组按其第一篇出现的位置排列 */
    section: z.string(),
    order: z.number().default(0),
    /** 依赖的功能开关：对应开关关闭时该页不进入构建产物（如公开 API 文档依赖 features.publicApi） */
    requires: z.enum(['publicApi']).optional(),
    content: z.string(),
  }),
  transform: async (document, context) => {
    // 文档站关闭时内容不进入构建产物，路由同时返回 404（tasks.md 3.4）
    if (!templateConfig.features.docs) return context.skip('features.docs=false')
    if (document.requires && !templateConfig.features[document.requires])
      return context.skip(`features.${document.requires}=false`)
    const { content, requires: _requires, ...data } = document
    const html = await renderMdx(context, { ...document, content: fillPlaceholders(content) })
    // 构建期生成的搜索文本，客户端按它做全文匹配（design.md 决策 1）
    return { ...data, ...localeAndSlug(document._meta), html, searchText: plainText(html) }
  },
})

export default defineConfig({ content: [posts, legalPages, docs] })
