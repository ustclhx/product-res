import { Input } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { type DocsNavSection, type DocsSearchEntry, searchDocs } from './content.ts'
import { MarketingShell } from './marketing-shell.tsx'
import { RichContent } from './rich-content.tsx'

interface DocsPageData {
  readonly page: {
    readonly slug: string
    readonly locale: string
    readonly title: string
    readonly description: string
    readonly html: string
  }
  readonly nav: readonly DocsNavSection[]
  readonly searchIndex: readonly DocsSearchEntry[]
}

/** 文档站（tasks.md 3.4）：侧边导航 + 构建期索引的客户端搜索 + 正文 */
export function DocsLayout({ page, nav, searchIndex }: DocsPageData) {
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 md:grid-cols-[14rem_1fr]">
        <aside className="grid content-start gap-6">
          <DocsSearch index={searchIndex} />
          <nav aria-label={m.marketing_docs_nav_label()} className="grid gap-5">
            {nav.map((section) => (
              <div key={section.title} className="grid gap-1.5">
                <p className="font-medium text-sm">{section.title}</p>
                <ul className="grid gap-1">
                  {section.items.map((item) => (
                    <li key={item.slug}>
                      <Link
                        to="/docs/$slug"
                        params={{ slug: item.slug }}
                        aria-current={item.slug === page.slug ? 'page' : undefined}
                        className="text-muted-foreground text-sm hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                      >
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <article lang={page.locale} className="grid min-w-0 content-start gap-3">
          <h1 className="font-bold text-3xl tracking-tight">{page.title}</h1>
          <p className="text-lg text-muted-foreground">{page.description}</p>
          <RichContent html={page.html} />
        </article>
      </div>
    </MarketingShell>
  )
}

function DocsSearch({ index }: { index: readonly DocsSearchEntry[] }) {
  const [query, setQuery] = useState('')
  const id = useId()
  const results = searchDocs(index, query)
  return (
    <search className="grid gap-2">
      <label htmlFor={id} className="sr-only">
        {m.marketing_docs_search_label()}
      </label>
      <Input
        id={id}
        type="search"
        value={query}
        placeholder={m.marketing_docs_search_placeholder()}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim() !== '' && (
        <ul aria-live="polite" className="grid gap-1 rounded-md border p-2">
          {results.length === 0 ? (
            <li className="text-muted-foreground text-sm">{m.marketing_docs_search_empty()}</li>
          ) : (
            results.map((entry) => (
              <li key={entry.slug}>
                <Link
                  to="/docs/$slug"
                  params={{ slug: entry.slug }}
                  onClick={() => setQuery('')}
                  className="grid rounded px-2 py-1 text-sm hover:bg-accent"
                >
                  <span className="font-medium">{entry.title}</span>
                  <span className="text-muted-foreground text-xs">{entry.description}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </search>
  )
}
