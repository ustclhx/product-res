import type { RateLimiter } from '@product-res/platform'
import { AppError, toErrorResponse } from '@product-res/shared'
import { currentRequestId, log } from '@product-res/shared/log'
import { z } from 'zod'
import { chatAppError, startWorkspaceChat, type WorkspaceChatDeps } from '../ai/chat.ts'
import { type ApiKeyDeps, authenticateApiKey } from './service.ts'

const requestSchema = z
  .object({
    model: z.string().min(1).max(200),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string().min(1).max(100_000),
        }),
      )
      .min(1)
      .max(128),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    max_tokens: z.number().int().positive().max(1_000_000).optional(),
    max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    n: z.literal(1).optional(),
  })
  .strict()

export function apiError(error: unknown): Response {
  const mapped = chatAppError(error)
  if (!(mapped instanceof AppError)) log.error('api.failed', { error })
  const { status, body } = toErrorResponse(mapped)
  return Response.json(
    {
      error: {
        ...body.error,
        type:
          status === 401
            ? 'authentication_error'
            : status >= 500
              ? 'server_error'
              : 'invalid_request_error',
        param: null,
      },
    },
    {
      status,
      headers: {
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(currentRequestId() ? { 'x-request-id': currentRequestId() as string } : {}),
      },
    },
  )
}

/** OpenAI Chat Completions 的文本子集；协议转换不承担计费职责。 */
export async function handleCompletions(
  request: Request,
  deps: ApiKeyDeps & WorkspaceChatDeps & { rateLimiter: RateLimiter },
) {
  try {
    const context = await authenticateApiKey(request, deps)
    const parsed = requestSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success)
      throw new AppError('INVALID_REQUEST', 'Unsupported or invalid chat completion request')
    const input = parsed.data
    const model = await deps.db.query.aiModel.findFirst({
      where: (m, { eq }) => eq(m.key, input.model),
    })
    if (!model) throw new AppError('MODEL_UNAVAILABLE', 'Model is not available', { status: 404 })
    const latest = input.messages.findLast((message) => message.role === 'user')
    if (!latest) throw new AppError('INVALID_REQUEST', 'At least one user message is required')
    const started = await startWorkspaceChat(
      {
        slug: context.workspace.slug,
        modelId: model.id,
        message: { role: 'user', parts: [{ type: 'text', text: latest.content }] },
      },
      {
        workspaceId: context.workspace.id,
        userId: context.user.id,
        prompt: input.messages.map((message) => ({ role: message.role, text: message.content })),
        maxOutputTokens: input.max_completion_tokens ?? input.max_tokens,
        temperature: input.temperature,
      },
      {
        ...deps,
        rateLimiter: undefined,
        entitlements: async () => context.entitlements,
        faultAccess: { enabled: false, platformAdmin: false },
      },
    )
    const base = {
      id: `chatcmpl-${started.metadata.messageId}`,
      created: Math.floor(Date.now() / 1000),
      model: input.model,
    }
    const headers = { 'x-request-id': currentRequestId() ?? '', 'Cache-Control': 'no-store' }
    const usageOf = (usage: {
      inputTokens?: number | undefined
      outputTokens?: number | undefined
    }) => ({
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    })
    const finish = (reason: string) => (reason === 'length' ? 'length' : 'stop')
    if (!input.stream) {
      const text = await started.result.text
      const usage = usageOf(await started.result.totalUsage)
      await started.done
      return Response.json(
        {
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text, refusal: null },
              finish_reason: finish(await started.result.finishReason),
              logprobs: null,
            },
          ],
          usage,
        },
        { headers },
      )
    }
    const encoder = new TextEncoder()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
      async start(controller) {
        const send = (value: unknown) => {
          if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
        }
        const chunk = (delta: Record<string, string>, finishReason: string | null = null) => ({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
          ...(input.stream_options?.include_usage ? { usage: null } : {}),
        })
        try {
          send(chunk({ role: 'assistant', content: '' }))
          for await (const part of started.result.fullStream) {
            if (cancelled) break
            if (part.type === 'error') throw part.error
            // 公开协议只转发正文；reasoning 与内部重试信号均不泄露给 API key 客户端。
            if (part.type === 'text-delta') send(chunk({ content: part.text }))
          }
          await started.done
          send(chunk({}, finish(await started.result.finishReason)))
          if (input.stream_options?.include_usage)
            send({
              ...base,
              object: 'chat.completion.chunk',
              choices: [],
              usage: usageOf(await started.result.totalUsage),
            })
        } catch (error) {
          const response = apiError(error)
          send(await response.json())
        } finally {
          if (!cancelled) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        }
      },
    })
    return new Response(stream, {
      headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' },
    })
  } catch (error) {
    return apiError(error)
  }
}
