import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseLocale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'
import {
  CHAT_ERROR_FALLBACK,
  type ChatUIMessage,
  chatErrorCode,
  chatErrorMessage,
  chatRequestBody,
  messageDisplayParts,
  messageReasoning,
  messageRetrying,
  messageText,
  streamingMessageId,
  titleFromText,
  toChatMessages,
} from './conversation.ts'

const locale = locales.find((locale) => String(locale) === 'en') ?? baseLocale
const fallback = String(locale) === 'zh' ? '操作失败，请重试。' : CHAT_ERROR_FALLBACK
beforeEach(() => overwriteGetLocale(() => locale))
afterEach(() => overwriteGetLocale(() => baseLocale))

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

describe('toChatMessages', () => {
  it('保留助手 reasoning 供折叠展示，但正文和请求不包含 reasoning', () => {
    const [message] = toChatMessages([
      {
        id: id(1),
        role: 'assistant',
        status: 'failed',
        parts: [
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: 'partial' },
        ],
      },
    ])
    if (!message) throw new Error('Missing assistant message')
    expect(messageReasoning(message)).toBe('private')
    expect(messageText(message)).toBe('partial')
    expect(message.metadata?.status).toBe('failed')
  })

  it('只保留用户与助手的文本内容，并带上保存时的状态', () => {
    const messages = toChatMessages([
      { id: id(1), role: 'system', parts: [{ type: 'text', text: 'hidden' }], status: 'completed' },
      { id: id(2), role: 'user', parts: [{ type: 'text', text: 'Hi' }], status: 'completed' },
      {
        id: id(3),
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hel' }, { type: 'reasoning' }, { type: 'text', text: 'lo' }],
        status: 'aborted',
      },
      { id: id(4), role: 'assistant', parts: [], status: 'streaming' },
    ])
    expect(messages).toEqual([
      {
        id: id(2),
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
        metadata: { messageId: id(2), status: 'completed' },
      },
      {
        id: id(3),
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
        metadata: { messageId: id(3), status: 'aborted' },
      },
      {
        id: id(4),
        role: 'assistant',
        parts: [],
        metadata: { messageId: id(4), status: 'streaming' },
      },
    ])
  })
})

describe('reasoning retries', () => {
  it('重试分界清除旧 reasoning，新输出结束重试提示且保留连续正文', () => {
    const message: ChatUIMessage = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'discarded' },
        { type: 'data-retry', data: { n: 1 } },
      ],
    }
    expect(messageReasoning(message)).toBe('')
    expect(messageRetrying(message)).toBe(true)
    message.parts.push({ type: 'reasoning', text: 'final' }, { type: 'text', text: 'Hello' })
    expect(messageReasoning(message)).toBe('final')
    expect(messageRetrying(message)).toBe(false)
    message.parts.push({ type: 'data-retry', data: { n: 2 } }, { type: 'text', text: ' world' })
    expect(messageText(message)).toBe('Hello world')
    expect(messageReasoning(message)).toBe('')
  })
})

describe('chatRequestBody', () => {
  it('显式 thinking 为 false 时仍提交，未暴露开关时不附带该字段', () => {
    const input = { slug: 'u-abc', modelId: id(9), conversationId: id(8), messages: [] }
    expect(chatRequestBody({ ...input, thinking: false })).toHaveProperty('thinking', false)
    expect(chatRequestBody(input)).not.toHaveProperty('thinking')
  })
  it('只提交最后一条用户消息的文本部分', () => {
    const messages: ChatUIMessage[] = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
      { id: 'c', role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ]
    expect(
      chatRequestBody({ slug: 'u-abc', modelId: id(9), conversationId: id(8), messages }),
    ).toEqual({
      slug: 'u-abc',
      modelId: id(9),
      conversationId: id(8),
      message: { role: 'user', parts: [{ type: 'text', text: 'second' }] },
    })
  })
})

describe('streamingMessageId', () => {
  it('取最后一条助手消息 start 事件中的 messageId', () => {
    const user: ChatUIMessage = { id: 'u', role: 'user', parts: [] }
    const started: ChatUIMessage = {
      id: 'x',
      role: 'assistant',
      parts: [],
      metadata: { messageId: id(5) },
    }
    expect(streamingMessageId([user], 'submitted')).toBeUndefined()
    expect(streamingMessageId([user, started], 'streaming')).toBe(id(5))
  })

  it('start 事件后、首个输出前（仍为 submitted）也返回 id，结束后不返回', () => {
    const started: ChatUIMessage = {
      id: 'x',
      role: 'assistant',
      parts: [],
      metadata: { messageId: id(5) },
    }
    expect(streamingMessageId([started], 'submitted')).toBe(id(5))
    expect(streamingMessageId([started], 'ready')).toBeUndefined()
    expect(streamingMessageId([started], 'error')).toBeUndefined()
  })
})

describe('chat errors', () => {
  it('从非 2xx 响应正文中读取错误码并给出可读提示', () => {
    const error = new Error(
      JSON.stringify({ error: { code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'x' } }),
    )
    expect(chatErrorCode(error)).toBe('AI_PROVIDER_NOT_CONFIGURED')
    expect(chatErrorMessage('AI_PROVIDER_NOT_CONFIGURED')).toBe(
      String(locale) === 'zh'
        ? '服务器尚未配置 AI 回复，请稍后重试。'
        : 'AI replies are not set up on this server yet. Please try later.',
    )
    for (const code of [
      'INSUFFICIENT_CREDITS',
      'CREDIT_DEBT',
      'RATE_LIMITED',
      'UPGRADE_REQUIRED',
      'MODEL_UNAVAILABLE',
    ])
      expect(chatErrorMessage(code)).not.toBe(fallback)
  })

  it('无法识别的错误使用通用提示', () => {
    expect(chatErrorCode(new Error('Failed to fetch'))).toBeUndefined()
    expect(chatErrorMessage(undefined)).toBe(fallback)
    expect(chatErrorMessage('SOMETHING_NEW')).toBe(fallback)
  })
})

describe('titleFromText', () => {
  it('合并空白并截断到标题长度', () => {
    expect(titleFromText('  hello\n\n world ')).toBe('hello world')
    expect(titleFromText('x'.repeat(200))).toHaveLength(80)
  })
})

it('历史读取开启时保留 reasoning，关闭时连已保存的 reasoning 也不下发', () => {
  const parts = [
    { type: 'reasoning', text: 'private' },
    { type: 'text', text: 'answer' },
    { type: 'tool', text: 'internal' },
  ]
  expect(messageDisplayParts(parts, true)).toEqual(parts.slice(0, 2))
  expect(messageDisplayParts(parts, false)).toEqual([{ type: 'text', text: 'answer' }])
})
