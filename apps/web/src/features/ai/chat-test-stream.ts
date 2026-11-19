// 对话组件单测用的模拟 UI message 流（SSE）：按需推送事件，可保持打开直到请求被中止。只供测试导入。

const encoder = new TextEncoder()

export interface FakeStream {
  /** 推送一个 UI message 流事件 */
  send(chunk: object): void
  /** 正常结束（finish + [DONE]） */
  finish(): void
  /** 请求体（JSON） */
  readonly body: Record<string, unknown>
  readonly aborted: boolean
}

export interface FakeChatServer {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** 已收到的对话请求（按顺序） */
  readonly streams: FakeStream[]
  /** 停止接口收到的请求路径 */
  readonly stops: string[]
  /** 停止接口收到的请求体（与 `stops` 同序） */
  readonly stopBodies: Record<string, unknown>[]
}

/**
 * `POST /api/ai/chat` 返回一个由测试控制的流；`/stop` 返回 `stopStatus`；
 * `reject` 给出时对话请求以该状态码与 JSON 拒绝。
 */
export function fakeChatServer(
  options: {
    stopStatus?: 'aborted' | 'failed' | 'completed'
    /** 停止接口返回 500 */
    stopFails?: boolean
    reject?: { status: number; json: unknown }
  } = {},
): FakeChatServer {
  const streams: FakeStream[] = []
  const stops: string[] = []
  const stopBodies: Record<string, unknown>[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/stop')) {
      stops.push(url)
      stopBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      if (options.stopFails) return new Response('error', { status: 500 })
      // 按请求 ID 停止（收到 start 之前）另带回复 ID；模拟回复尚未入库
      if (url.endsWith('/api/ai/chat/stop'))
        return Response.json({ status: options.stopStatus ?? 'aborted', messageId: null })
      return Response.json({ status: options.stopStatus ?? 'aborted' })
    }
    if (options.reject)
      return new Response(JSON.stringify(options.reject.json), {
        status: options.reject.status,
        headers: { 'content-type': 'application/json' },
      })
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const state = { aborted: false }
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    init?.signal?.addEventListener('abort', () => {
      state.aborted = true
      try {
        controller.error(new DOMException('Aborted', 'AbortError'))
      } catch {}
    })
    streams.push({
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      get aborted() {
        return state.aborted
      },
      send(chunk) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      },
      finish() {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'finish' })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    })
  }
  return { fetch, streams, stops, stopBodies }
}

/** 流的开头：start（带消息 ID 元数据）与正文段开始 */
export function startReply(stream: FakeStream, messageId: string, conversationId = 'c') {
  stream.send({ type: 'start', messageId, messageMetadata: { conversationId, messageId } })
  stream.send({ type: 'start-step' })
}
