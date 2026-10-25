import {
  transferWorkflowToken,
  type WorkspaceTransferWorkflowParams,
} from '@product-res/follow/transfer'
import type { Workflow, WorkflowInstance, WorkflowState } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { z } from 'zod'

type ClientOptions = { jobsUrl: string; secret: string; fetch?: typeof globalThis.fetch }

const instanceResult = z.object({ id: z.string().min(1) })
const stateResult = z.object({
  status: z.enum(['queued', 'running', 'paused', 'waiting', 'completed', 'failed', 'terminated']),
  output: z.json().optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
})
const errorResult = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
const safeErrors: Readonly<Record<string, { status: number; message: string }>> = {
  WORKFLOW_NOT_FOUND: { status: 404, message: 'Workflow instance not found' },
  CAPABILITY_UNAVAILABLE: { status: 503, message: 'Transfer workflow is not available' },
  WORKFLOW_STOPPING: { status: 503, message: 'Workflow engine is stopping' },
}
const unavailable = () =>
  new AppError('WORKFLOW_UNAVAILABLE', 'Transfer workflow is not available', { status: 503 })

/**
 * 流转 Workflow 的 Node 客户端（add-workspace-data-transfer 4.1）：与媒体 Workflow 相同，web 只调用
 * jobs 的内部 HTTP 边界；Bearer 由 BETTER_AUTH_SECRET 派生（packages/follow/src/transfer/workflow.ts）。
 * 取消经数据库状态驱动，因此实例不支持 terminate / sendEvent。
 */
export function createNodeTransferWorkflowClient(
  options: ClientOptions,
): Workflow<WorkspaceTransferWorkflowParams> {
  const endpoint = new URL('/internal/workflows/workspace-transfer', options.jobsUrl)
  const fetch = options.fetch ?? globalThis.fetch
  const token = transferWorkflowToken(options.secret)

  async function request<T>(body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    let result: unknown
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      })
      result = await response.json()
    } catch {
      // 网络错误与解析异常可能含 URL 或上游正文，不能作为 cause 传播
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
        throw unavailable()
      },
      async sendEvent() {
        throw unavailable()
      },
    }
  }

  return {
    async create({ id, params }) {
      const result = await request(
        { operation: 'create', id: id ?? params.transferId, params },
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
