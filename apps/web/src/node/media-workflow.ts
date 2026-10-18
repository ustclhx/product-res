import type { JsonValue, Workflow, WorkflowInstance, WorkflowState } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { z } from 'zod'

type MediaWorkflowParams = { taskId: string; requestId?: string }
type ClientOptions = { jobsUrl: string; secret: string; fetch?: typeof globalThis.fetch }

const instanceResult = z.object({ id: z.string().min(1) })
const stateResult = z.object({
  status: z.enum(['queued', 'running', 'paused', 'waiting', 'completed', 'failed', 'terminated']),
  output: z.json().optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
})
const voidResult = z.object({ ok: z.literal(true) })
const errorResult = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
const safeErrors: Readonly<Record<string, { status: number; message: string }>> = {
  WORKFLOW_NOT_FOUND: { status: 404, message: 'Workflow instance not found' },
  WORKFLOW_TERMINAL: { status: 409, message: 'Workflow instance is terminal' },
  CAPABILITY_UNAVAILABLE: { status: 503, message: 'Media workflow is not available' },
  WORKFLOW_STOPPING: { status: 503, message: 'Workflow engine is stopping' },
}
const unavailable = () =>
  new AppError('WORKFLOW_UNAVAILABLE', 'Media workflow is not available', { status: 503 })

/** web 只调用 jobs 的中立 HTTP 边界，不在请求进程启动持久引擎。 */
export function createNodeMediaWorkflowClient(
  options: ClientOptions,
): Workflow<MediaWorkflowParams> {
  const endpoint = new URL('/internal/workflows/ai-media', options.jobsUrl)
  const fetch = options.fetch ?? globalThis.fetch

  async function request<T>(body: JsonValue, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    let result: unknown
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      })
      result = await response.json()
    } catch {
      // 网络错误与解析异常可能含 URL、凭据或上游正文，不能作为 cause 传播。
      throw unavailable()
    }
    if (!response.ok) {
      const parsed = errorResult.safeParse(result)
      const safe = parsed.success ? safeErrors[parsed.data.error.code] : undefined
      if (parsed.success && safe && safe.status === response.status)
        throw new AppError(parsed.data.error.code, safe.message, { status: safe.status })
      throw unavailable()
    }
    const parsed = schema.safeParse(result)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }

  function instance(id: string): WorkflowInstance {
    return {
      id,
      async status(): Promise<WorkflowState> {
        const state = await request({ operation: 'status', id }, stateResult)
        return {
          status: state.status,
          ...(state.output === undefined ? {} : { output: state.output }),
          ...(state.error === undefined ? {} : { error: state.error }),
        }
      },
      async terminate() {
        await request({ operation: 'terminate', id }, voidResult)
      },
      async sendEvent(event) {
        await request({ operation: 'sendEvent', id, event }, voidResult)
      },
    }
  }

  return {
    async create({ id, params }) {
      const result = await request(
        { operation: 'create', ...(id === undefined ? {} : { id }), params },
        instanceResult,
      )
      return instance(result.id)
    },
    async get(id) {
      const result = await request({ operation: 'get', id }, instanceResult)
      return instance(result.id)
    },
  }
}
