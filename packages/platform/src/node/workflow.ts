import { DBOS } from '@dbos-inc/dbos-sdk'
import { jobWorkflowWait } from '@product-res/db'
import { AppError, newId } from '@product-res/shared'
import { withLogContext } from '@product-res/shared/log'
import { and, eq } from 'drizzle-orm'
import type { JsonValue, Workflow, WorkflowState, WorkflowStep } from '../workflow.ts'
import type { NodeJobEngine } from './job-engine.ts'
import { sendNodeWorkflowEvent } from './workflow-events.ts'
import { jsonValue } from './workflow-json.ts'
import { workflowOperation } from './workflow-native.ts'
import { createNodeWorkflowStep } from './workflow-step.ts'

export interface NodeWorkflowOptions<P extends JsonValue, R extends JsonValue> {
  readonly engine: NodeJobEngine
  /** handler 版本属于名称；更新旧流程步骤顺序前先完成旧实例或保留原版本 handler。 */
  readonly name: string
  readonly handler: (params: P, step: WorkflowStep) => Promise<R>
}

function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    throw new AppError('WORKFLOW_INVALID_ID', 'Invalid workflow identity')
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** 在 engine.register 中装配；业务 ID 可为任意合法字符串，不与队列/native UUID 混用。 */
export function createNodeWorkflow<P extends JsonValue, R extends JsonValue = JsonValue>(
  options: NodeWorkflowOptions<P, R>,
): Workflow<P, R> & { stopReceiving(): void } {
  const name = identifier(options.name)
  const nativeName = `product-res-workflow:${options.name}`
  const queueName = `workflow-${name}`
  let receiving = true
  const workflow = DBOS.registerWorkflow(
    async (params: P) => {
      await options.engine.assertOwnership()
      const input = jsonValue(params) as P
      const metadata: Record<string, string> = { jobId: DBOS.workflowID as string }
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        for (const key of ['requestId', 'workspaceId']) {
          const value = input[key]
          if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
            metadata[key] = value
        }
      }
      return withLogContext(metadata, async () => {
        const result = await options.handler(
          input,
          createNodeWorkflowStep(options.engine, DBOS.workflowID as string),
        )
        return jsonValue(result) as R
      })
    },
    { name: nativeName, serialization: 'portable' },
  )
  const nativeId = (id: string) => `workflow:${name}:${identifier(id)}`
  async function status(id: string): Promise<WorkflowState<R>> {
    const state = await DBOS.getWorkflowStatus(nativeId(id))
    if (!state || state.workflowName !== nativeName)
      throw new AppError('WORKFLOW_NOT_FOUND', 'Workflow instance not found', { status: 404 })
    switch (state.status) {
      case 'ENQUEUED':
      case 'DELAYED':
        return { status: 'queued' }
      case 'PENDING': {
        const [wait] = await options.engine.database
          .select({ id: jobWorkflowWait.id })
          .from(jobWorkflowWait)
          .where(
            and(eq(jobWorkflowWait.workflowId, nativeId(id)), eq(jobWorkflowWait.state, 'waiting')),
          )
          .limit(1)
        return { status: wait ? 'waiting' : 'running' }
      }
      case 'SUCCESS':
        return { status: 'completed', output: jsonValue(state.output) as R }
      case 'ERROR':
      case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
        return {
          status: 'failed',
          error: { name: 'WorkflowError', message: 'Workflow execution failed' },
        }
      case 'CANCELLED':
        return { status: 'terminated' }
      default:
        throw new AppError('WORKFLOW_UNKNOWN_STATUS', 'Unknown workflow engine state', {
          status: 503,
        })
    }
  }
  const instance = (id: string) => ({
    id,
    status: () => workflowOperation(() => status(id)),
    async terminate() {
      await workflowOperation(async () => {
        await status(id)
        await options.engine.assertOwnership()
        await DBOS.cancelWorkflow(nativeId(id))
      })
    },
    async sendEvent(event: { type: string; payload: JsonValue }) {
      await workflowOperation(() => sendNodeWorkflowEvent(options.engine, nativeId(id), event))
    },
  })
  return {
    stopReceiving() {
      receiving = false
    },
    async create({ id = newId(), params }) {
      nativeId(id)
      const input = jsonValue(params) as P
      if (!receiving)
        throw new AppError('WORKFLOW_STOPPING', 'Workflow engine is stopping', { status: 503 })
      await workflowOperation(async () => {
        await options.engine.assertOwnership()
        await DBOS.registerQueue(queueName)
        await DBOS.startWorkflow(workflow, { workflowID: nativeId(id), queueName })(input)
      })
      return instance(id)
    },
    async get(id) {
      await workflowOperation(() => status(id))
      return instance(id)
    },
  }
}
