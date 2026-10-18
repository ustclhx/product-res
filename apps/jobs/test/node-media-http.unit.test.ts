import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Workflow } from '@product-res/platform'
import { AppError, newId } from '@product-res/shared'
import { expect, it, vi } from 'vitest'
import { createNodeMediaWorkflowHttpHandler } from '../src/node/media-http.ts'

async function serve(workflow: Workflow<{ taskId: string }>) {
  const handler = createNodeMediaWorkflowHttpHandler({
    workflow: { available: true, value: workflow },
    secret: 'local-fixture-only',
  })
  const server = createServer((request, response) => void handler(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    async request(body: unknown, authorized = true) {
      return fetch(`http://127.0.0.1:${address.port}/internal/workflows/ai-media`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { authorization: 'Bearer local-fixture-only' } : {}),
        },
        body: JSON.stringify(body),
      })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it('rejects unauthenticated, mismatched task identity and oversized input before creating work', async () => {
  const create = vi.fn()
  const get = vi.fn()
  const http = await serve({ create, get })
  try {
    const taskId = newId()
    const body = { operation: 'create', id: taskId, params: { taskId } }
    expect((await http.request(body, false)).status).toBe(401)
    expect((await http.request({ ...body, id: newId() })).status).toBe(400)
    expect((await http.request({ ...body, padding: 'x'.repeat(16_384) })).status).toBe(400)
    expect(create).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  } finally {
    await http.close()
  }
})

it('keeps terminal platform errors and redacts unknown engine failures', async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new AppError('WORKFLOW_TERMINAL', 'unsafe upstream body'))
    .mockRejectedValueOnce(new Error('unsafe upstream credential'))
  const http = await serve({ create: vi.fn(), get })
  try {
    const command = { operation: 'status', id: newId() }
    const terminal = await http.request(command)
    expect(terminal.status).toBe(409)
    expect(terminal.headers.get('cache-control')).toBe('no-store')
    expect(await terminal.json()).toEqual({
      error: { code: 'WORKFLOW_TERMINAL', message: 'Workflow instance is terminal' },
    })
    const failed = await http.request(command)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: { code: 'WORKFLOW_UNAVAILABLE', message: 'Media workflow is unavailable' },
    })
  } finally {
    await http.close()
  }
})
