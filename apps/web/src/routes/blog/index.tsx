import { createFileRoute } from '@tanstack/react-router'
import { PostList, TagLinks } from '../../features/marketing/blog/post-list.tsx'
import { getBlogIndex } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { originFromMatches, pageHead, staticPage } from '../../features/seo/metadata.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/blog/')({
  loader: () => getBlogIndex({ data: { locale: getLocale() } }),
  head: ({ matches }) => pageHead(staticPage('/blog', getLocale()), originFromMatches(matches)),
  component: BlogIndexPage,
})

function BlogIndexPage() {
  const { posts, tags } = Route.useLoaderData()
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-3xl gap-10 px-4 py-16">
        <header className="grid gap-3">
          <h1 className="font-bold text-4xl tracking-tight">{m.marketing_blog_title()}</h1>
          <p className="text-muted-foreground">{m.marketing_blog_subtitle()}</p>
          <TagLinks tags={tags} />
        </header>
        <PostList posts={posts} />
      </div>
    </MarketingShell>
  )
}
