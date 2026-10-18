import { Link } from '@tanstack/react-router'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'

export interface PostSummary {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly date: string
  readonly tags: readonly string[]
  readonly draft: boolean
}

export function formatDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(date),
  )
}

export function TagLinks({ tags }: { tags: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <li key={tag}>
          <Link
            to="/blog/tags/$tag"
            params={{ tag }}
            className="rounded-full border px-2.5 py-0.5 text-muted-foreground text-xs hover:text-foreground"
          >
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function PostList({ posts }: { posts: readonly PostSummary[] }) {
  const locale = getLocale()
  if (posts.length === 0) return <p className="text-muted-foreground">{m.marketing_blog_empty()}</p>
  return (
    <ul className="grid gap-8">
      {posts.map((post) => (
        <li key={post.slug} className="grid gap-2">
          <p className="text-muted-foreground text-sm">
            <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
            {post.draft && ` · ${m.marketing_blog_draft()}`}
          </p>
          <h2 className="font-semibold text-xl">
            <Link to="/blog/$slug" params={{ slug: post.slug }} className="hover:underline">
              {post.title}
            </Link>
          </h2>
          <p className="text-muted-foreground">{post.summary}</p>
          <TagLinks tags={post.tags} />
        </li>
      ))}
    </ul>
  )
}
