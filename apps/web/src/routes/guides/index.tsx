import { createFileRoute, Link } from '@tanstack/react-router'
import { getGuideIndex } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { originFromMatches, pageHead, staticPage } from '../../features/seo/metadata.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/guides/')({
  loader: () => getGuideIndex({ data: { locale: getLocale() } }),
  head: ({ matches }) => pageHead(staticPage('/guides', getLocale()), originFromMatches(matches)),
  component: GuideIndexPage,
})

function GuideIndexPage() {
  const guides = Route.useLoaderData()
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-3xl gap-10 px-4 py-16">
        <header className="grid gap-3">
          <h1 className="font-bold text-4xl tracking-tight">{m.marketing_guides_title()}</h1>
          <p className="text-muted-foreground">{m.marketing_guides_subtitle()}</p>
        </header>
        <ul className="grid gap-6">
          {guides.map((guide) => (
            <li key={guide.slug} className="grid gap-1">
              <Link
                to="/guides/$slug"
                params={{ slug: guide.slug }}
                className="font-semibold text-xl hover:underline"
              >
                {guide.title}
              </Link>
              <p className="text-muted-foreground">{guide.answer_summary}</p>
            </li>
          ))}
        </ul>
      </div>
    </MarketingShell>
  )
}
