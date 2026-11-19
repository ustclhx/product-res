import { createFileRoute, Link } from '@tanstack/react-router'
import { ChatPage } from '../../../../features/ai/chat-page.tsx'
import { ChatPageSkeleton } from '../../../../features/ai/chat-page-skeleton.tsx'
import { getConversation } from '../../../../features/ai/conversations.functions.ts'
import { getPickerModels } from '../../../../features/ai/model-picker.functions.ts'
import { useAppShellBarAvailable } from '../../../../features/app-shell/bar.tsx'
import { m } from '../../../../paraglide/messages.js'

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
    meta: loaderData ? [{ title: loaderData.conversation.title || m.chat_ui_untitled() }] : [],
  }),
  component: ConversationPage,
  pendingComponent: ChatPageSkeleton,
  // 对话区头部即页面标题（版式取舍 2），顶部条不再显示「对话」标题；
  // 输入区贴底，顶部布局下也不显示浮动语言 / 主题控件与页末设置行，避免遮挡发送按钮（#373）
  staticData: { shellTitle: false, floatingControls: false },
  notFoundComponent: ConversationNotFound,
})

/** 顶部条不显示标题（staticData.shellTitle = false），侧边栏布局下这里是页面 h1 */
function ConversationNotFound() {
  const { slug } = Route.useParams()
  const Heading = useAppShellBarAvailable() ? 'h1' : 'h2'
  return (
    <section className="grid gap-2">
      <Heading className="text-2xl font-semibold">{m.chat_ui_not_found_title()}</Heading>
      <p>{m.chat_ui_not_found_body()}</p>
      <Link to="/app/$slug/chat" params={{ slug }} className="underline">
        {m.chat_ui_back_to_chats()}
      </Link>
    </section>
  )
}

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
      initialFeedback={page.feedback}
    />
  )
}
