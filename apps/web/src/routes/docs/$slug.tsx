import { createFileRoute } from '@tanstack/react-router'
import { getDocsPage } from '../../features/marketing/content.functions.ts'
import { DocsLayout } from '../../features/marketing/docs-layout.tsx'
import { originFromMatches, pageHead } from '../../features/seo/metadata.ts'
import { getLocale } from '../../paraglide/runtime.js'

// features.docs 关闭时 getDocsPage 抛出 notFound（404）
export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => getDocsPage({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData, params, matches }) =>
    loaderData
      ? pageHead(
          {
            path: `/docs/${encodeURIComponent(params.slug)}`,
            locale: getLocale(),
            title: loaderData.page.title,
            description: loaderData.page.description,
          },
          originFromMatches(matches),
        )
      : {},
  component: DocsPage,
})

function DocsPage() {
  return <DocsLayout {...Route.useLoaderData()} />
}
