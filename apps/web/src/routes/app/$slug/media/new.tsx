import { createFileRoute } from '@tanstack/react-router'
import { getMediaSubmitPage } from '../../../../features/ai-media/page.functions.ts'
import { MediaSubmitPage } from '../../../../features/ai-media/page.tsx'
import { m } from '../../../../paraglide/messages.js'

export const Route = createFileRoute('/app/$slug/media/new')({
  loader: ({ params }) => getMediaSubmitPage({ data: { slug: params.slug } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.media_title() }] }),
  component: MediaPage,
})

function MediaPage() {
  const page = Route.useLoaderData()
  return <MediaSubmitPage key={page.workspaceId} page={page} />
}
