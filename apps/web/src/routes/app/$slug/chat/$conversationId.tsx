import { createFileRoute, Link } from '@tanstack/react-router'
import { ChatPage } from '../../../../features/ai/chat-page.tsx'
import { getConversation } from '../../../../features/ai/conversations.functions.ts'
import { getPickerModels } from '../../../../features/ai/model-picker.functions.ts'

export const Route = createFileRoute('/app/$slug/chat/$conversationId')({
  loader: async ({ params }) => {
    const input = { slug: params.slug, conversationId: params.conversationId }
    const [page, models] = await Promise.all([
      getConversation({ data: input }),
      getPickerModels({ data: { slug: params.slug, kind: 'text' } }),
    ])
    return { ...page, models }
  },
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.conversation.title || 'New chat' }] : [],
  }),
  component: ConversationPage,
  notFoundComponent: () => {
    const { slug } = Route.useParams()
    return (
      <section className="grid gap-2">
        <h2 className="text-2xl font-semibold">Conversation not found</h2>
        <p>This conversation does not exist or you do not have access to it.</p>
        <Link to="/app/$slug/chat" params={{ slug }} className="underline">
          Back to chats
        </Link>
      </section>
    )
  },
})

function ConversationPage() {
  const page = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <ChatPage
      key={page.conversation.id}
      slug={slug}
      conversation={page.conversation}
      storedMessages={page.messages}
      models={page.models}
      readOnly={page.readOnly}
    />
  )
}
