import type { ChatStatus, UIMessage } from 'ai'
import { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import type { ChatRequest } from './chat.ts'

/**
 * 对话页的纯函数（tasks.md 3.1）：数据库消息 → `useChat` 消息、每轮请求体、错误提示。
 * 服务端以数据库历史为准，客户端每轮只提交本轮的用户消息（见 `chat.ts` 的 `chatRequestSchema`）。
 */

export type ChatMessageStatus = 'streaming' | 'completed' | 'aborted' | 'failed'

/** 消息元数据：流式回复由 start 事件带上 `conversationId` / `messageId`，历史消息带保存时的状态 */
export interface ChatUIMetadata {
  readonly conversationId?: string
  readonly messageId?: string
  readonly status?: ChatMessageStatus
}

export type ChatUIMessage = UIMessage<ChatUIMetadata, { retry: { n: number } }>

/** 对话标题的最大长度；新建对话标题为空，首轮回复完成后取首条消息 */
export const CONVERSATION_TITLE_LENGTH = 80
export const conversationTitleSchema = z.string().trim().min(1).max(CONVERSATION_TITLE_LENGTH)

export const conversationTitle = (title: string) => title || 'New chat'

export const titleFromText = (text: string) =>
  text.trim().replace(/\s+/g, ' ').slice(0, CONVERSATION_TITLE_LENGTH)

const textPart = z.object({ type: z.literal('text'), text: z.string() })

/** 数据库中 `parts` 的文本部分（首版对话只有文本） */
export const textParts = (parts: readonly unknown[]) =>
  parts.flatMap((part) => {
    const parsed = textPart.safeParse(part)
    return parsed.success ? [{ type: 'text' as const, text: parsed.data.text }] : []
  })

const textOf = (parts: readonly unknown[]) =>
  textParts(parts)
    .map((part) => part.text)
    .join('')

export const messageText = (message: Pick<UIMessage, 'parts'>) => textOf(message.parts)

/** 重试数据部件是 attempt 分界；旧 reasoning 不再展示，正文续写始终连续。 */
export function messageReasoning(message: ChatUIMessage) {
  const retry = message.parts.findLastIndex((part) => part.type === 'data-retry')
  return message.parts
    .slice(retry + 1)
    .flatMap((part) => (part.type === 'reasoning' ? [part.text] : []))
    .join('')
}

export function messageRetrying(message: ChatUIMessage): boolean {
  const retry = message.parts.findLastIndex((part) => part.type === 'data-retry')
  return (
    retry >= 0 &&
    !message.parts
      .slice(retry + 1)
      .some((part) => (part.type === 'text' || part.type === 'reasoning') && part.text)
  )
}

/** 服务器历史读取也执行展示策略，关闭后旧 reasoning 不会再发到浏览器。 */
export function messageDisplayParts(parts: readonly unknown[], displayReasoning: boolean) {
  const schema = z.object({ type: z.enum(['text', 'reasoning']), text: z.string() })
  return parts.flatMap((part) => {
    const parsed = schema.safeParse(part)
    return parsed.success && (parsed.data.type === 'text' || displayReasoning) ? [parsed.data] : []
  })
}

/** 数据库中的消息行（`getConversation` 的返回项） */
export interface StoredMessage {
  readonly id: string
  readonly role: string
  readonly parts: readonly unknown[]
  readonly status: ChatMessageStatus
}

/** reasoning 只用于助手展示；请求与输入 token 估算仍只取正文。 */
export function toChatMessages(rows: readonly StoredMessage[]): ChatUIMessage[] {
  return rows.flatMap((row) => {
    if (row.role !== 'user' && row.role !== 'assistant') return []
    const text = textOf(row.parts)
    const reasoning =
      row.role === 'assistant'
        ? row.parts.flatMap((part) => {
            const parsed = z
              .object({ type: z.literal('reasoning'), text: z.string() })
              .safeParse(part)
            return parsed.success
              ? [{ type: 'reasoning' as const, text: parsed.data.text, state: 'done' as const }]
              : []
          })
        : []
    if (!text && row.role === 'user') return []
    return [
      {
        id: row.id,
        role: row.role,
        parts: [...reasoning, ...(text ? [{ type: 'text' as const, text }] : [])],
        metadata: { messageId: row.id, status: row.status },
      },
    ]
  })
}

/** 每轮请求体：只发送最后一条用户消息的文本部分 */
export function chatRequestBody(input: {
  slug: string
  modelId: string
  conversationId: string
  messages: readonly UIMessage[]
  thinking?: boolean
}): ChatRequest {
  const last = input.messages.findLast((message) => message.role === 'user')
  const parts = (last?.parts ?? []).flatMap((part) =>
    part.type === 'text' && part.text ? [{ type: 'text' as const, text: part.text }] : [],
  )
  return {
    slug: input.slug,
    modelId: input.modelId,
    conversationId: input.conversationId,
    message: { role: 'user', parts },
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  }
}

/**
 * 正在生成的助手消息 id（停止接口需要），取自 start 事件的 metadata。
 * AI SDK 收到 start 事件时只写入消息、保持 submitted，首个内容到达才切到 streaming；
 * 首个输出前停止同样必须通知服务端，否则只中断本地读取，服务端继续生成并全额结算。
 */
export function streamingMessageId(
  messages: readonly ChatUIMessage[],
  status: ChatStatus,
): string | undefined {
  if (status !== 'submitted' && status !== 'streaming') return undefined
  const last = messages.at(-1)
  return last?.role === 'assistant' ? last.metadata?.messageId : undefined
}

const CHAT_ERRORS: Record<string, () => string> = {
  INSUFFICIENT_CREDITS: () => m.chat_error_insufficient_credits(),
  CREDIT_DEBT: () => m.chat_error_credit_debt(),
  RATE_LIMITED: () => m.chat_error_rate_limited(),
  UPGRADE_REQUIRED: () => m.chat_error_upgrade_required(),
  MODEL_UNAVAILABLE: () => m.chat_error_model_unavailable(),
  AI_PROVIDER_NOT_CONFIGURED: () => m.chat_error_ai_provider_not_configured(),
  INPUT_TOO_LONG: () => m.chat_error_input_too_long(),
  WORKSPACE_READ_ONLY: () => m.chat_error_workspace_read_only(),
  NOT_FOUND: () => m.chat_error_not_found(),
  INVALID_REQUEST: () => m.chat_error_invalid_request(),
}

export const CHAT_ERROR_FALLBACK = 'Something went wrong. Please try again.'

export function chatErrorMessage(code: string | undefined): string {
  return (code && CHAT_ERRORS[code]?.()) || m.chat_error_unknown()
}

const errorBody = z.object({ error: z.object({ code: z.string() }) })

/** API 错误码：`useChat` 把非 2xx 响应的正文作为 Error 的 message */
export function chatErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  try {
    const parsed = errorBody.safeParse(JSON.parse(error.message))
    return parsed.success ? parsed.data.error.code : undefined
  } catch {
    return undefined
  }
}

/**
 * 停止接口（`POST /api/ai/chat/:messageId/stop`）的响应：已结束的消息幂等返回当前状态，
 * 先前已因出错结束时为 `failed`
 */
export const stopResponseSchema = z.object({ status: z.enum(['aborted', 'completed', 'failed']) })
