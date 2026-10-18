import { createServer } from 'node:http'
import { AppError } from '@product-res/shared'
import { expect, it, vi } from 'vitest'
import { createNodeMediaWorkflowClient } from './media-workflow.ts'

it('routes every operation to jobs and preserves instance identity, event and requestId', async () => {
  const requests: {
    path: string
    method: string | undefined
    authorization: string | undefined
    body: unknown
  }[] = []
  const state = { status: 'completed', output: { files: ['file-1'] } }
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push({
      path: request.url ?? '',
      method: request.method,
      authorization: request.headers.authorization,
      body,
    })
    const result =
      body.operation === 'create' || body.operation === 'get'
        ? { id: body.id ?? 'jobs-generated-id' }
        : body.operation === 'status'
          ? state
          : { ok: true }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  try {
    const client = createNodeMediaWorkflowClient({
      jobsUrl: `http://127.0.0.1:${address.port}/ignored/base`,
      secret: 'fixture-secret',
    })
    const created = await client.create({
      id: 'task-id',
      params: { taskId: 'task-id', requestId: 'request-id' },
    })
    const generated = await client.create({ params: { taskId: 'another-task' } })
    expect(generated.id).toBe('jobs-generated-id')
    const found = await client.get(created.id)
    // 从实例抽取方法仍使用创建该 handle 时的 ID，不依赖调用者的 receiver。
    const { status, sendEvent, terminate } = found
    expect(await status()).toEqual(state)
    await sendEvent({ type: 'media-done', payload: { taskId: 'task-id' } })
    await terminate()
    expect(requests.map((item) => item.body)).toEqual([
      {
        operation: 'create',
        id: 'task-id',
        params: { taskId: 'task-id', requestId: 'request-id' },
      },
      { operation: 'create', params: { taskId: 'another-task' } },
      { operation: 'get', id: 'task-id' },
      { operation: 'status', id: 'task-id' },
      {
        operation: 'sendEvent',
        id: 'task-id',
        event: { type: 'media-done', payload: { taskId: 'task-id' } },
      },
      { operation: 'terminate', id: 'task-id' },
    ])
    for (const request of requests) {
      expect(request).toMatchObject({
        path: '/internal/workflows/ai-media',
        method: 'POST',
        authorization: 'Bearer fixture-secret',
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each([
  ['WORKFLOW_NOT_FOUND', 404, 'Workflow instance not found'],
  ['WORKFLOW_TERMINAL', 409, 'Workflow instance is terminal'],
  ['CAPABILITY_UNAVAILABLE', 503, 'Media workflow is not available'],
  ['WORKFLOW_STOPPING', 503, 'Workflow engine is stopping'],
])(
  'keeps safe business error %s while discarding the upstream message',
  async (code, status, message) => {
    const client = createNodeMediaWorkflowClient({
      jobsUrl: 'http://jobs.test',
      secret: 'private-secret',
      fetch: vi.fn(async () =>
        Response.json({ error: { code, message: 'private-secret upstream-body' } }, { status }),
      ),
    })
    const error = await client
      .create({ id: 'task', params: { taskId: 'task' } })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({
      name: 'AppError',
      code,
      status,
      message,
    })
    expect((error as AppError).cause).toBeUndefined()
  },
)

it.each([
  async () => {
    throw new Error('private-secret network-body')
  },
  async () =>
    Response.json({ error: { code: 'UNKNOWN', message: 'private-secret' } }, { status: 500 }),
  async () =>
    Response.json(
      { error: { code: 'WORKFLOW_NOT_FOUND', message: 'private-secret' } },
      { status: 500 },
    ),
  async () => new Response('private-secret malformed-body'),
  async () => Response.json({ id: '' }),
])('normalizes network and untrusted create responses without exposing causes', async (fetch) => {
  const client = createNodeMediaWorkflowClient({
    jobsUrl: 'http://jobs.test',
    secret: 'private-secret',
    fetch,
  })
  const error = await client.create({ params: { taskId: 'task' } }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({
    code: 'WORKFLOW_UNAVAILABLE',
    status: 503,
    message: 'Media workflow is not available',
  })
  expect((error as AppError).cause).toBeUndefined()
  expect(JSON.stringify(error)).not.toContain('private-secret')
})

it('rejects invalid status JSON and unacknowledged void operations', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ id: 'task' }))
    .mockResolvedValueOnce(Response.json({ status: 'unknown', output: {} }))
    .mockResolvedValueOnce(Response.json({ ok: false }))
  const client = createNodeMediaWorkflowClient({
    jobsUrl: 'http://jobs.test',
    secret: 'fixture-secret',
    fetch,
  })
  const instance = await client.get('task')
  await expect(instance.status()).rejects.toMatchObject({
    code: 'WORKFLOW_UNAVAILABLE',
    status: 503,
  })
  await expect(instance.terminate()).rejects.toMatchObject({
    code: 'WORKFLOW_UNAVAILABLE',
    status: 503,
  })
})

it('bounds each HTTP operation with a five-second AbortSignal', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: 'task' }))
  try {
    const client = createNodeMediaWorkflowClient({
      jobsUrl: 'http://jobs.test',
      secret: 'fixture-secret',
      fetch,
    })
    await client.get('task')
    expect(timeout).toHaveBeenCalledWith(5_000)
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  } finally {
    timeout.mockRestore()
  }
})
