import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Capability, Workflow } from '@product-res/platform'
import { requireCapability } from '@product-res/platform'
import { AppError, MEDIA_DONE_EVENT } from '@product-res/shared'
import { z } from 'zod'

const identity = z.uuid()
const instance = z.object({ id: identity })
const commandSchema = z.discriminatedUnion('operation', [
  instance.extend({ operation: z.literal('get') }).strict(),
  instance.extend({ operation: z.literal('status') }).strict(),
  instance.extend({ operation: z.literal('terminate') }).strict(),
  instance
    .extend({
      operation: z.literal('sendEvent'),
      event: z.object({ type: z.literal(MEDIA_DONE_EVENT), payload: z.json() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('create'),
      id: identity.optional(),
      params: z
        .object({ taskId: identity, requestId: z.string().min(1).max(128).optional() })
        .strict(),
    })
    .strict(),
])

// 私网接口也验证身份和输入；只返回固定平台摘要，不透传 SDK/驱动错误或输入正文。
const errors: Record<string, [number, string]> = {
  WORKFLOW_NOT_FOUND: [404, 'Workflow instance not found'],
  WORKFLOW_TERMINAL: [409, 'Workflow instance is terminal'],
  WORKFLOW_STOPPING: [503, 'Workflow engine is stopping'],
  CAPABILITY_UNAVAILABLE: [503, 'Media workflow is unavailable'],
  INVALID_REQUEST: [400, 'Invalid workflow request'],
  UNAUTHORIZED: [401, 'Unauthorized'],
}

/** 只挂载到 jobs 内部网络；复用媒体回调密钥鉴权，web 无需另启 DBOS executor。 */
export function createNodeMediaWorkflowHttpHandler(options: {
  workflow: Capability<Workflow<{ taskId: string; requestId?: string }>>
  secret: string
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json')
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${options.secret}`)
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
        if (bytes > 16_384) throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
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
      const workflow = requireCapability(options.workflow, 'Media workflow')
      if (command.operation === 'create') {
        // 媒体身份固定 task.id；禁止请求用另一个 instance ID 重复运行同一业务任务。
        if (command.id !== undefined && command.id !== command.params.taskId)
          throw new AppError('INVALID_REQUEST', 'Invalid workflow request')
        const created = await workflow.create({
          id: command.params.taskId,
          params: {
            taskId: command.params.taskId,
            ...(command.params.requestId === undefined
              ? {}
              : { requestId: command.params.requestId }),
          },
        })
        response.end(JSON.stringify({ id: created.id }))
        return
      }
      const handle = await workflow.get(command.id)
      switch (command.operation) {
        case 'get':
          response.end(JSON.stringify({ id: handle.id }))
          return
        case 'status':
          response.end(JSON.stringify(await handle.status()))
          return
        case 'terminate':
          await handle.terminate()
          break
        case 'sendEvent':
          await handle.sendEvent(command.event)
          break
      }
      response.end(JSON.stringify({ ok: true }))
    } catch (error) {
      const code =
        error instanceof AppError && errors[error.code] ? error.code : 'WORKFLOW_UNAVAILABLE'
      const [status, message] = errors[code] ?? [503, 'Media workflow is unavailable']
      response.writeHead(status).end(JSON.stringify({ error: { code, message } }))
    }
  }
}
