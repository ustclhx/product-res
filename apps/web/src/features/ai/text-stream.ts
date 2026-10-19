import { estimateTextTokens, getTextProviderCapabilities } from '@product-res/ai'
import { AppError } from '@product-res/shared'
import {
  APICallError,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
} from 'ai'
import type { ChatMessageMetadata } from './chat.ts'

interface Usage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}
export interface ChatAttemptResult extends Usage {
  text: string
  reasoning: string
  absorbed: Usage
  total: Usage
  usageSource: 'actual' | 'estimated'
  status: 'completed' | 'aborted' | 'failed'
  finishReason: FinishReason
}
type Part =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string; attempt: number }
  | { type: 'reasoning-end'; attempt: number }
  | { type: 'data-retry'; data: { n: number } }
  | { type: 'error'; error: unknown }
  /** 空闲心跳：只为让代理看到字节，序列化时转为客户端忽略的片段 */
  | { type: 'keepalive' }

/**
 * Cloudflare 边缘（橙云代理与 Tunnel）开始响应前或两段数据之间约 100 秒无字节即返回 524；
 * 推理模型隐藏思考阶段可能长时间不输出，按此间隔补发心跳，给网络抖动留足余量。
 */
export const STREAM_HEARTBEAT_MS = 25_000

const emptyReply = () =>
  new AppError('AI_EMPTY_REPLY', 'The model returned no visible reply', { status: 502 })

/** 用户停止必须打断退避；不让重试越过同一预扣的截止时间。 */
export function chatRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function retryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable
  // 网络断流、超时及 fetch 异常没有 HTTP 状态；确定业务拒绝不能自动重试。
  return !(error instanceof AppError) || error.code === 'AI_EMPTY_REPLY'
}

/** 单回复共享预扣、正文与 UI 消息；SDK 的每次调用都禁用内置重试。 */
export function createChatStream(options: {
  model: LanguageModel
  provider: string
  messages: ModelMessage[]
  thinking: boolean | undefined
  continuation: boolean
  displayReasoning: boolean
  inputTokens: number
  tokensPerChar: number
  maxOutputTokens: number
  temperature: number | undefined
  controller: AbortController
  deadline: number
  retryDelay: (ms: number, signal: AbortSignal) => Promise<void>
  checkpoint: (snapshot: Omit<ChatAttemptResult, 'status' | 'finishReason' | 'usageSource'>) => void
  settle: (result: ChatAttemptResult) => Promise<void>
  /** 无输出时的心跳间隔，默认 `STREAM_HEARTBEAT_MS`；测试可调 */
  heartbeatMs?: number
}) {
  let sink!: ReadableStreamDefaultController<Part>
  let cancelled = false
  let closed = false
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const heartbeatMs = options.heartbeatMs ?? STREAM_HEARTBEAT_MS
  const stopHeartbeat = () => {
    clearTimeout(heartbeat)
    heartbeat = undefined
  }
  // 每次真实输出都重新计时，只有静默满一个间隔才补发；流结束或取消后不再留定时器。
  const armHeartbeat = () => {
    stopHeartbeat()
    if (!cancelled && !closed)
      heartbeat = setTimeout(() => emit({ type: 'keepalive' }), heartbeatMs)
  }
  const fullStream = new ReadableStream<Part>({
    start(controller) {
      sink = controller
    },
    cancel() {
      cancelled = true
      stopHeartbeat()
    },
  })
  const emit = (part: Part) => {
    if (cancelled || closed) return
    sink.enqueue(part)
    armHeartbeat()
  }
  armHeartbeat()
  const done = (async () => {
    const capabilities = getTextProviderCapabilities(options.provider)
    const signal = options.controller.signal
    const absorbed: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    const total: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    let text = ''
    let reasoning = ''
    let inputTokens = options.inputTokens
    let outputTokens = 0
    let reasoningTokens = 0
    let actual = true
    let retry = 0
    let continuation = 0
    let attempt = 0
    let status: ChatAttemptResult['status'] = 'failed'
    let finishReason: FinishReason = 'error'
    let lastError: unknown = emptyReply()
    while (!signal.aborted && Date.now() < options.deadline) {
      const prefix = text
      const estimatedInput =
        options.inputTokens + (prefix ? 8 + estimateTextTokens(prefix, options.tokensPerChar) : 0)
      reasoning = ''
      let attemptText = ''
      let attemptReasoning = ''
      let usage: LanguageModelUsage | undefined
      let failure: unknown
      let reason: FinishReason = 'error'
      const estimate = () => ({
        inputTokens: estimatedInput,
        total: {
          inputTokens: total.inputTokens + estimatedInput,
          outputTokens:
            total.outputTokens +
            estimateTextTokens(attemptText + attemptReasoning, options.tokensPerChar),
          reasoningTokens:
            total.reasoningTokens + estimateTextTokens(attemptReasoning, options.tokensPerChar),
        },
        outputTokens:
          outputTokens + estimateTextTokens(attemptText + attemptReasoning, options.tokensPerChar),
        reasoningTokens:
          reasoningTokens + estimateTextTokens(attemptReasoning, options.tokensPerChar),
        text,
        reasoning: options.displayReasoning ? reasoning : '',
        absorbed: { ...absorbed },
      })
      const params =
        options.thinking === undefined ? {} : capabilities.applyThinking({}, options.thinking)
      const response = streamText({
        ...params,
        model: options.model,
        maxRetries: 0,
        allowSystemInMessages: true,
        messages:
          prefix && capabilities.continuation
            ? capabilities.continuation.buildPrefix(options.messages, prefix)
            : options.messages,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        maxOutputTokens: options.maxOutputTokens,
        abortSignal: signal,
        onEnd: (event) => {
          usage = event.totalUsage
          reason = event.finishReason
        },
        onError: ({ error }) => {
          failure = error
        },
      })
      try {
        for await (const chunk of response.fullStream) {
          if (chunk.type === 'error') failure = chunk.error
          if (chunk.type === 'abort' && !signal.aborted)
            failure = new Error('Upstream generation aborted')
          if (chunk.type === 'text-delta') {
            attemptText += chunk.text
            text += chunk.text
            emit({ type: 'text-delta', text: chunk.text })
            options.checkpoint(estimate())
          }
          if (chunk.type === 'reasoning-delta') {
            attemptReasoning += chunk.text
            if (options.displayReasoning) {
              reasoning += chunk.text
              emit({ type: 'reasoning-delta', text: chunk.text, attempt })
            }
            options.checkpoint(estimate())
          }
        }
      } catch (error) {
        failure = error
      }
      if (options.displayReasoning && attemptReasoning) emit({ type: 'reasoning-end', attempt })
      const measured: Usage = {
        inputTokens: usage?.inputTokens ?? estimatedInput,
        outputTokens:
          usage?.outputTokens ??
          estimateTextTokens(attemptText + attemptReasoning, options.tokensPerChar),
        reasoningTokens:
          usage?.outputTokenDetails?.reasoningTokens ??
          estimateTextTokens(attemptReasoning, options.tokensPerChar),
      }
      total.inputTokens += measured.inputTokens
      total.outputTokens += measured.outputTokens
      total.reasoningTokens += measured.reasoningTokens
      const completeUsage = usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      if (attemptText || prefix || signal.aborted) {
        inputTokens = measured.inputTokens
        outputTokens += measured.outputTokens
        reasoningTokens += measured.reasoningTokens
        actual &&= completeUsage
      } else {
        absorbed.inputTokens += measured.inputTokens
        absorbed.outputTokens += measured.outputTokens
        absorbed.reasoningTokens += measured.reasoningTokens
      }
      if (signal.aborted) {
        status = 'aborted'
        finishReason = 'other'
        break
      }
      if (!failure && text && reason !== 'error') {
        status = 'completed'
        finishReason = reason
        break
      }
      lastError = failure ?? emptyReply()
      if (!prefix && !attemptText) {
        if (retry >= 2 || !retryable(lastError)) break
        const delay = retry === 0 ? 1000 : 3000
        if (Date.now() + delay >= options.deadline) break
        retry++
        emit({ type: 'data-retry', data: { n: retry } })
        // 已丢弃的 attempt 不参与当前检查点，避免回收时重复收费。
        reasoning = ''
        options.checkpoint({
          inputTokens: options.inputTokens,
          outputTokens,
          reasoningTokens,
          text,
          reasoning,
          absorbed: { ...absorbed },
          total: { ...total },
        })
        await options.retryDelay(delay, signal)
      } else {
        if (
          !options.continuation ||
          !capabilities.continuation ||
          continuation >= 2 ||
          !retryable(lastError)
        )
          break
        continuation++
      }
      attempt++
    }
    if (signal.aborted) status = 'aborted'
    const outcome: ChatAttemptResult = {
      text,
      reasoning,
      inputTokens,
      outputTokens,
      reasoningTokens,
      absorbed,
      total,
      status,
      finishReason,
      usageSource: actual ? 'actual' : 'estimated',
    }
    try {
      await options.settle(outcome)
    } finally {
      if (status === 'failed') emit({ type: 'error', error: lastError })
      closed = true
      stopHeartbeat()
      if (!cancelled) sink.close()
    }
    return outcome
  })()
  // 结算前的意外异常不会走到上面的 finally，同样要停止心跳；拒绝仍由调用方的 done 处理。
  const halt = () => {
    closed = true
    stopHeartbeat()
  }
  void done.then(halt, halt)
  return {
    done,
    fullStream,
    text: done.then((result) => result.text),
    totalUsage: done.then((result) => ({
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })),
    finishReason: done.then((result) => result.finishReason),
    toUIMessageStreamResponse({
      metadata,
      headers,
    }: {
      metadata: ChatMessageMetadata
      headers: Record<string, string>
    }) {
      return createUIMessageStreamResponse({
        headers,
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({
              type: 'start',
              messageId: metadata.messageId,
              messageMetadata: metadata,
            })
            let textStarted = false
            const reasoningStarted = new Set<number>()
            for await (const part of fullStream) {
              if (part.type === 'text-delta') {
                if (!textStarted) {
                  writer.write({ type: 'text-start', id: 'text' })
                  textStarted = true
                }
                writer.write({ type: 'text-delta', id: 'text', delta: part.text })
              } else if (part.type === 'reasoning-delta') {
                const id = `reasoning-${part.attempt}`
                if (!reasoningStarted.has(part.attempt)) {
                  writer.write({ type: 'reasoning-start', id })
                  reasoningStarted.add(part.attempt)
                }
                writer.write({ type: 'reasoning-delta', id, delta: part.text })
              } else if (part.type === 'reasoning-end') {
                writer.write({ type: 'reasoning-end', id: `reasoning-${part.attempt}` })
              } else if (part.type === 'keepalive')
                // transient 数据片段不进入消息 parts，useChat 解析后直接丢弃，只起保活作用。
                writer.write({ type: 'data-keepalive', data: null, transient: true })
              else if (part.type === 'data-retry') writer.write(part)
              else writer.write({ type: 'error', errorText: 'The reply failed. Please try again.' })
            }
            if (textStarted) writer.write({ type: 'text-end', id: 'text' })
            const outcome = await done
            writer.write({ type: 'finish', finishReason: outcome.finishReason })
          },
        }),
      })
    },
  }
}
