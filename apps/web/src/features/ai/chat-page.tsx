import { useChat } from '@ai-sdk/react'
import { estimateInputTokens } from '@product-res/ai/client'
import { Button, Label } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { DefaultChatTransport } from 'ai'
import { useMemo, useRef, useState } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { FormAlert } from '../auth/auth-layout.tsx'
import { HydratedControls } from '../workspace/components.tsx'
import {
  type ChatMessageStatus,
  type ChatUIMessage,
  chatErrorCode,
  chatErrorMessage,
  chatRequestBody,
  conversationTitle,
  messageReasoning,
  messageRetrying,
  messageText,
  type StoredMessage,
  stopResponseSchema,
  streamingMessageId,
  titleFromText,
  toChatMessages,
} from './conversation.ts'
import { renameConversation } from './conversations.functions.ts'
import type { PickerModel } from './model-picker.ts'
import { CreditEstimateText, ModelPicker } from './model-picker.tsx'

const BILLING_CODES = new Set(['INSUFFICIENT_CREDITS', 'CREDIT_DEBT', 'UPGRADE_REQUIRED'])

/**
 * 对话页（tasks.md 3.1）：`useChat` 经 `POST /api/ai/chat` 流式回复，每轮只提交本轮用户消息；
 * 停止按钮调用 `POST /api/ai/chat/:messageId/stop`（messageId 来自流 start 事件的 metadata），
 * 接口错误码显示为可读提示。
 */
export function ChatPage({
  slug,
  conversation,
  storedMessages,
  models,
  readOnly,
}: {
  slug: string
  conversation: { id: string; title: string }
  storedMessages: readonly StoredMessage[]
  models: readonly PickerModel[]
  readOnly: boolean
}) {
  const [modelId, setModelId] = useState(models[0]?.id)
  const model = models.find((m) => m.id === modelId)
  const canToggleThinking = templateConfig.ai.text.thinking.userToggle && model?.supportsThinking
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(templateConfig.ai.text.thinking.default === 'on')
  const [title, setTitle] = useState(conversation.title)
  // 停止接口返回的消息状态，覆盖流中的状态显示
  const [ended, setEnded] = useState<Record<string, ChatMessageStatus>>({})
  const [stopError, setStopError] = useState<string | null>(null)
  // transport 只创建一次，发送时读取当前选择的模型
  const modelRef = useRef(modelId)
  modelRef.current = modelId
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking
  const canToggleThinkingRef = useRef(canToggleThinking)
  canToggleThinkingRef.current = canToggleThinking
  const titleRef = useRef(title)

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: '/api/ai/chat',
        prepareSendMessagesRequest: ({ messages }) => ({
          body: chatRequestBody({
            slug,
            modelId: modelRef.current ?? '',
            conversationId: conversation.id,
            messages,
            ...(canToggleThinkingRef.current ? { thinking: thinkingRef.current } : {}),
          }),
        }),
      }),
    [slug, conversation.id],
  )
  const initialMessages = useMemo(() => toChatMessages(storedMessages), [storedMessages])
  const { messages, sendMessage, status, stop, error, clearError } = useChat<ChatUIMessage>({
    id: conversation.id,
    messages: initialMessages,
    transport,
    onFinish: ({ messages, isError, isAbort }) => {
      // 新建的对话标题为空：首轮回复完成后取首条消息作为标题
      if (isError || isAbort || titleRef.current) return
      const first = messages.find((message) => message.role === 'user')
      const next = first ? titleFromText(messageText(first)) : ''
      if (!next) return
      titleRef.current = next
      setTitle(next)
      void renameConversation({ data: { slug, conversationId: conversation.id, title: next } })
    },
  })

  const busy = status === 'submitted' || status === 'streaming'
  const inputTokens = estimateInputTokens([
    ...messages.map((message) => ({ text: messageText(message) })),
    { text: input },
  ])
  const errorCode = error ? chatErrorCode(error) : undefined

  function submit() {
    const text = input.trim()
    if (!text || !modelId || busy) return
    setStopError(null)
    clearError()
    setInput('')
    void sendMessage({ text })
  }

  async function stopReply() {
    const messageId = streamingMessageId(messages, status)
    setStopError(null)
    // 先通知服务端停止上游生成，再中断本地读取（服务端在客户端断开后仍会继续读完模型流）
    const request = messageId
      ? fetch(`/api/ai/chat/${messageId}/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug }),
        })
      : undefined
    await stop()
    if (!messageId || !request) return
    try {
      const response = await request
      const parsed = stopResponseSchema.safeParse(await response.json())
      if (!response.ok || !parsed.success) throw new Error('stop failed')
      const status = parsed.data.status
      setEnded((old) => ({ ...old, [messageId]: status }))
    } catch {
      setStopError('Could not stop the reply on the server. It may continue in the background.')
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold" data-testid="conversation-title">
          {conversationTitle(title)}
        </h2>
        <Link to="/app/$slug/chat" params={{ slug }} className="underline">
          All chats
        </Link>
      </div>
      <ol aria-label="Messages" className="grid gap-4">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            status={ended[message.id] ?? message.metadata?.status}
            live={busy && message === messages.at(-1)}
          />
        ))}
      </ol>
      {messages.length === 0 ? <p>Send a message to start the conversation.</p> : null}
      {error ? (
        <div className="grid gap-2">
          <FormAlert message={chatErrorMessage(errorCode)} />
          {errorCode && BILLING_CODES.has(errorCode) ? (
            <Link to="/app/$slug/billing" params={{ slug }} className="underline">
              Go to billing
            </Link>
          ) : null}
        </div>
      ) : null}
      <FormAlert message={stopError} />
      {readOnly ? <p role="status">This workspace is read-only.</p> : null}
      <form
        aria-label="Send a message"
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <HydratedControls>
          <ModelPicker models={models} value={modelId} onChange={setModelId} disabled={busy} />
          {canToggleThinking ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={thinking}
                disabled={busy || readOnly}
                onChange={(event) => setThinking(event.target.checked)}
              />
              Thinking
            </label>
          ) : null}
          <p className="grid gap-1">
            <Label htmlFor="chat-input">Message</Label>
            <textarea
              id="chat-input"
              className="min-h-24 rounded-md border p-2"
              value={input}
              disabled={readOnly}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {busy ? (
              <Button type="button" variant="outline" onClick={() => void stopReply()}>
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={readOnly || !model || !input.trim()}>
                Send
              </Button>
            )}
            <CreditEstimateText model={model} inputTokens={inputTokens} />
          </div>
        </HydratedControls>
      </form>
    </div>
  )
}

function ChatMessage({
  message,
  status,
  live,
}: {
  message: ChatUIMessage
  status: ChatMessageStatus | undefined
  live: boolean
}) {
  const reasoning = templateConfig.ai.text.reasoning.display ? messageReasoning(message) : ''
  const retrying = live && messageRetrying(message)
  const note =
    status === 'aborted'
      ? 'Stopped'
      : status === 'failed'
        ? 'This reply failed. Please try again.'
        : status === 'streaming' && !live
          ? 'Incomplete'
          : null
  return (
    <li className="grid gap-1" data-role={message.role} aria-label={roleName(message.role)}>
      <span className="text-muted-foreground text-sm">{roleName(message.role)}</span>
      {reasoning ? (
        <details className="text-muted-foreground text-sm">
          <summary>Reasoning</summary>
          <p className="whitespace-pre-wrap">{reasoning}</p>
        </details>
      ) : null}
      <p className="whitespace-pre-wrap">{messageText(message)}</p>
      {retrying ? <span role="status">Retrying…</span> : null}
      {note ? <span className="text-muted-foreground text-sm">{note}</span> : null}
    </li>
  )
}

const roleName = (role: string) => (role === 'user' ? 'You' : 'Assistant')
