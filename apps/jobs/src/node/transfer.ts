import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TemplateConfig } from '@product-res/config'
import type { Database } from '@product-res/db'
import {
  transferWorkflowToken,
  WORKSPACE_TRANSFER_WORKFLOW,
  type WorkspaceTransferWorkflowParams,
} from '@product-res/follow/transfer'
import {
  type Capability,
  type KeyValueStore,
  requireCapability,
  type Workflow,
  type WorkflowStep,
} from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { newRequestId, withLogContext } from '@product-res/shared/log'
import { z } from 'zod'
import templateConfig from '../../../../template.config.ts'
import { type JobObserver, logJobObserver, withJobObserver } from '../observer.ts'
import { runWorkspaceTransfer } from '../workflows/transfer-runner.ts'

export { WORKSPACE_TRANSFER_WORKFLOW, type WorkspaceTransferWorkflowParams }

export interface NodeTransferWorkflowOptions {
  readonly cache: Pick<KeyValueStore, 'delete'>
  readonly template?: TemplateConfig
  readonly observer?: JobObserver
}

/** 引擎注册留在 composition；业务 handler 只接收借用的数据库与正式步骤。 */
export function createNodeTransferHandler(db: Database, options: NodeTransferWorkflowOptions) {
  const observer = options.observer ?? logJobObserver
  const template = options.template ?? templateConfig
  return async (params: WorkspaceTransferWorkflowParams, step: WorkflowStep) =>
    withLogContext(
      { requestId: params.requestId ?? newRequestId(), transferId: params.transferId },
      () =>
        withJobObserver(observer, async () => {
          observer.tagContext()
          return runWorkspaceTransfer(params.transferId, step, {
            db,
            config: template,
            cache: options.cache,
            observer,
          })
        }),
    )
}

const identity = z.uuid()
// 续跑实例 id 为 `<流转 id>-<uuid>`（packages/follow/src/transfer/workflow.ts）
const instanceId = z.string().regex(/^[0-9a-f-]{36}(?:-[0-9a-f-]{36})?$/i)
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'), id: instanceId }).strict(),
  z.object({ operation: z.literal('status'), id: instanceId }).strict(),
  z
    .object({
      operation: z.literal('create'),
      id: instanceId,
      params: z
        .object({ transferId: identity, requestId: z.string().min(1).max(128).optional() })
        .strict(),
    })
    .strict(),
])

const errors: Record<string, [number, string]> = {
  WORKFLOW_NOT_FOUND: [404, 'Workflow instance not found'],
  WORKFLOW_STOPPING: [503, 'Workflow engine is stopping'],
  CAPABILITY_UNAVAILABLE: [503, 'Transfer workflow is unavailable'],
  INVALID_REQUEST: [400, 'Invalid workflow request'],
  UNAUTHORIZED: [401, 'Unauthorized'],
}

/**
 * 只挂载到 jobs 内部网络（与媒体 Workflow 的 HTTP 边界相同）；Bearer 由 BETTER_AUTH_SECRET 派生。
 * 只开放 create / get / status：取消经数据库状态驱动，不需要 terminate / sendEvent。
 */
export function createNodeTransferWorkflowHttpHandler(options: {
  workflow: Capability<Workflow<WorkspaceTransferWorkflowParams>>
  secret: string
}) {
  const token = options.secret ? transferWorkflowToken(options.secret) : Promise.resolve('')
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${await token}`)
      if (
        !options.secret ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new AppError('UNAUTHORIZED', 'Unauthorized', { status: 401 })
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        response.writeHead(405).end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }))
        return
      }
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 4_096) throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
        chunks.push(buffer)
      }
      let input: unknown
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
      }
      const parsed = commandSchema.safeParse(input)
      if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
      const command = parsed.data
      const workflow = requireCapability(options.workflow, 'Transfer workflow')
      if (command.operation === 'create') {
        // 实例 id 必须以流转 id 开头，禁止用任意 id 驱动别的流转
        if (!command.id.startsWith(command.params.transferId))
          throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
        const created = await workflow.create({
          id: command.id,
          params: {
            transferId: command.params.transferId,
            ...(command.params.requestId === undefined
              ? {}
              : { requestId: command.params.requestId }),
          },
        })
        response.end(JSON.stringify({ id: created.id }))
        return
      }
      const handle = await workflow.get(command.id)
      if (command.operation === 'get') response.end(JSON.stringify({ id: handle.id }))
      else response.end(JSON.stringify(await handle.status()))
    } catch (error) {
      const code =
        error instanceof AppError && errors[error.code] ? error.code : 'WORKFLOW_UNAVAILABLE'
      const [status, message] = errors[code] ?? [503, 'Transfer workflow is unavailable']
      response.writeHead(status).end(JSON.stringify({ error: { code, message } }))
    }
  }
}
