import { createFileRoute } from '@tanstack/react-router'
import { getPickerModels } from '../../../../features/ai/model-picker.functions.ts'
import { getTemporarySubjectChat } from '../../../../features/ai/subject-chat.functions.ts'
import { TemporarySubjectChat } from '../../../../features/ai/subject-chat.tsx'

/**
 * 临时上下文对话页（add-subject-chat design 决策 4）：地址只带签名令牌，上下文正文留在服务端 KV。
 * 令牌无效时提示并返回对话列表；过期时引导回签发时的原页面。
 */
export const Route = createFileRoute('/app/$slug/chat/context')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token.slice(0, 1024) : '',
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ params, deps }) => {
    if (!deps.token) return { page: { status: 'invalid' as const, readOnly: false }, models: [] }
    const [page, models] = await Promise.all([
      getTemporarySubjectChat({ data: { slug: params.slug, token: deps.token } }),
      getPickerModels({ data: { slug: params.slug, kind: 'text' } }),
    ])
    return { page, models }
  },
  staleTime: 0,
  head: () => ({ meta: [{ title: 'Chat' }] }),
  component: ContextChatPage,
})

function ContextChatPage() {
  const { page, models } = Route.useLoaderData()
  const { slug } = Route.useParams()
  const { token } = Route.useSearch()
  return <TemporarySubjectChat slug={slug} token={token} page={page} models={models} />
}
