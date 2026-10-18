import { createFileRoute } from '@tanstack/react-router'
import { ConversationList } from '../../../../features/ai/conversation-list.tsx'
import { listConversations } from '../../../../features/ai/conversations.functions.ts'

export const Route = createFileRoute('/app/$slug/chat/')({
  loader: ({ params }) => listConversations({ data: { slug: params.slug } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: 'Chats' }] }),
  component: ConversationsPage,
})

function ConversationsPage() {
  const page = Route.useLoaderData()
  const { slug } = Route.useParams()
  return <ConversationList slug={slug} page={page} />
}
