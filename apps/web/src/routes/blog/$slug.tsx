import { createFileRoute, Link } from '@tanstack/react-router'
import { formatDate, TagLinks } from '../../features/marketing/blog/post-list.tsx'
import { getBlogPost } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { RichContent } from '../../features/marketing/rich-content.tsx'
import { originFromMatches, pageHead } from '../../features/seo/metadata.ts'
import { articleData } from '../../features/seo/structured-data.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/blog/$slug')({
  loader: ({ params }) => getBlogPost({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData, params, matches }) => {
    if (!loaderData) return {}
    const page = {
      path: `/blog/${encodeURIComponent(params.slug)}`,
      locale: getLocale(),
      title: loaderData.title,
      description: loaderData.summary,
      cover: loaderData.cover,
      date: loaderData.date,
    }
    const appUrl = originFromMatches(matches)
    return pageHead(page, appUrl, [articleData(page, appUrl)])
  },
  component: BlogPostPage,
})

function BlogPostPage() {
  const post = Route.useLoaderData()
  return (
    <MarketingShell>
      <article lang={post.locale} className="mx-auto grid max-w-3xl gap-6 px-4 py-16">
        <Link to="/blog" className="text-muted-foreground text-sm hover:text-foreground">
          ← {m.marketing_blog_back()}
        </Link>
        <header className="grid gap-3">
          <p className="text-muted-foreground text-sm">
            <time dateTime={post.date}>{formatDate(post.date, getLocale())}</time>
            {post.draft && ` · ${m.marketing_blog_draft()}`}
          </p>
          <h1 className="font-bold text-4xl tracking-tight">{post.title}</h1>
          <p className="text-lg text-muted-foreground">{post.summary}</p>
          <TagLinks tags={post.tags} />
        </header>
        {post.cover && <img src={post.cover} alt="" className="w-full rounded-xl border" />}
        <RichContent html={post.html} />
      </article>
    </MarketingShell>
  )
}
