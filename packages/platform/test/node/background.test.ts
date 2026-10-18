import { spawn } from 'node:child_process'
import { createServer, get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { withLogContext } from '@product-res/shared/log'
import { describe, expect, it, vi } from 'vitest'
import { createNodeBackgroundTasks } from '../../src/node/index.ts'

async function signalShutdown(mode: string) {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    fileURLToPath(new URL('./fixtures/shutdown.ts', import.meta.url)),
    mode,
  ])
  let stdout = ''
  let stderr = ''
  let signaledAt = 0
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    if (!signaledAt && stdout.includes('ready')) {
      signaledAt = Date.now()
      child.kill('SIGTERM')
    }
  })
  try {
    const code = await exit
    return { code, stdout, stderr, elapsed: Date.now() - signaledAt }
  } finally {
    clearTimeout(timer)
  }
}

describe('Node background continuation', () => {
  it('finishes registered work after response completion and a real client disconnect', async () => {
    const tasks = createNodeBackgroundTasks()
    let completed = 0
    const server = createServer((request, response) => {
      const release = tasks.beginRequest()
      tasks.waitUntil(
        delay(40).then(() => {
          completed++
        }),
      )
      if (request.url === '/complete') response.end('ok')
      else response.write('stream-start')
      response.once('close', release)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const base = `http://127.0.0.1:${address.port}`
    try {
      expect(await (await fetch(`${base}/complete`)).text()).toBe('ok')
      await new Promise<void>((resolve, reject) => {
        const client = get(`${base}/disconnect`, (response) => {
          response.once('data', () => {
            response.destroy()
            resolve()
          })
        })
        client.once('error', reject)
      })
      expect((await tasks.drain(1_000)).completed).toBe(true)
      expect(completed).toBe(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('handles rejection immediately and logs only its safe event/request context', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks = createNodeBackgroundTasks()
    try {
      withLogContext({ requestId: 'background-id' }, () => {
        tasks.waitUntil(Promise.reject(new Error('secret password and user message')))
      })
      await tasks.drain(100)
      expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
        level: 'error',
        event: 'platform.background.failed',
        requestId: 'background-id',
      })
      // Vitest 与真实 Node 子进程均会因未处理 rejection 失败。
    } finally {
      spy.mockRestore()
    }
  })

  it('bounds shutdown even when resource closure hangs, and never closes before drain', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tasks = createNodeBackgroundTasks()
    const order: string[] = []
    tasks.waitUntil(
      delay(10).then(() => {
        order.push('task')
      }),
    )
    try {
      const start = Date.now()
      const result = await tasks.shutdown({
        timeoutMs: 50,
        stopReceiving: () => {
          order.push('stop')
        },
        closeResources: () => {
          order.push('close')
          return new Promise(() => {})
        },
      })
      expect(order).toEqual(['stop', 'task', 'close'])
      expect(result).toMatchObject({ completed: true, resourcesClosed: false })
      expect(Date.now() - start).toBeLessThan(300)
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['complete', 'timeout'])('drains or times out on real SIGTERM: %s', async (mode) => {
    const result = await signalShutdown(mode)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('platform.background.failed')
    expect(result.stderr).not.toContain('fixture private rejection content')
    expect(result.elapsed).toBeLessThan(1_000)
    expect(result.stdout.indexOf('stop')).toBeLessThan(result.stdout.indexOf('close-cache-db'))
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1) as string)
    if (mode === 'complete') {
      expect(summary).toEqual({
        completed: true,
        pendingTasks: 0,
        activeRequests: 0,
        resourcesClosed: true,
      })
      expect(result.stdout.indexOf('late-task')).toBeLessThan(
        result.stdout.indexOf('close-cache-db'),
      )
    } else {
      expect(summary).toEqual({
        completed: false,
        pendingTasks: 1,
        activeRequests: 1,
        resourcesClosed: true,
      })
      expect(result.stderr).toContain('platform.background.drain_timeout')
    }
  })
})
