import { randomUUID } from 'node:crypto'
import { connect, createServer, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { toErrorResponse } from '@product-res/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeCache } from '../../src/node/index.ts'

type Cache = Awaited<ReturnType<typeof createNodeCache>>
const url = process.env.TEST_VALKEY_URL
if (!url) throw new Error('TEST_VALKEY_URL is required for Node cache integration tests')
const namespace = `selfhost-a3-test-${randomUUID()}`
let web: Cache
let jobs: Cache
let other: Cache
beforeAll(async () => {
  const policies = {
    auth: { limit: 3, periodSeconds: 1 },
    ai: { limit: 5, periodSeconds: 1 },
    api: { limit: 7, periodSeconds: 1 },
  }
  web = await createNodeCache({ url, namespace, policies })
  jobs = await createNodeCache({ url, namespace, policies })
  other = await createNodeCache({ url, namespace: `${namespace}-other`, policies })
})
afterAll(async () => {
  await Promise.all([web?.close(), jobs?.close(), other?.close()])
})

describe('shared Valkey adapters', () => {
  it('shares text/JSON, isolates purposes/namespaces and deletes across clients', async () => {
    const auth = web.kv('auth')
    await auth.put('shared', JSON.stringify({ session: 'test' }))
    expect(await jobs.kv('auth').get('shared')).toBe('{"session":"test"}')
    expect(await jobs.kv('auth').get('shared', 'json')).toEqual({ session: 'test' })
    expect(await jobs.kv('settings').get('shared')).toBeNull()
    expect(await other.kv('auth').get('shared')).toBeNull()
    await jobs.kv('auth').delete('shared')
    expect(await auth.get('shared')).toBeNull()
    await auth.put('ttl', 'expires', { expirationTtl: 1 })
    expect(await jobs.kv('auth').get('ttl')).toBe('expires')
    await delay(1_100)
    expect(await jobs.kv('auth').get('ttl')).toBeNull()
    // 不带 TTL 的覆盖写会移除旧过期时间，与 SET 一致。
    await auth.put('overwrite', 'old', { expirationTtl: 1 })
    await auth.put('overwrite', 'new')
    await delay(1_100)
    expect(await jobs.kv('auth').get('overwrite')).toBe('new')
    await auth.delete('overwrite')
  })

  it('atomically shares all policy counters without mixing keys or extending windows', async () => {
    for (const [policy, limit] of [
      ['auth', 3],
      ['ai', 5],
      ['api', 7],
    ] as const) {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? web : jobs).rateLimiter.limit(policy, 'ip')),
      )
      expect(results.filter((r) => r.success)).toHaveLength(limit)
      expect(await web.rateLimiter.limit(policy, 'another-ip')).toEqual({ success: true })
      expect(await other.rateLimiter.limit(policy, 'ip')).toEqual({ success: true })
    }
    await delay(600)
    expect(await jobs.rateLimiter.limit('auth', 'ip')).toEqual({ success: false })
    await delay(500)
    expect(await web.rateLimiter.limit('auth', 'ip')).toEqual({ success: true })
  })

  it('fails closed with safe 503 on startup and after a live connection is lost', async () => {
    // 专用本地 TCP 端口立即断开，避免借用或停止其他测试资源。
    const server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing test address')
    try {
      await expect(
        createNodeCache({
          url: `redis://127.0.0.1:${address.port}`,
          namespace,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE', status: 503 })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    const silentSockets = new Set<Socket>()
    const silent = createServer((socket) => {
      silentSockets.add(socket)
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const silentAddress = silent.address()
    if (!silentAddress || typeof silentAddress === 'string')
      throw new Error('Missing silent address')
    try {
      const start = Date.now()
      await expect(
        createNodeCache({
          url: `redis://127.0.0.1:${silentAddress.port}`,
          namespace,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE', status: 503 })
      expect(Date.now() - start).toBeLessThan(1_000)
    } finally {
      for (const socket of silentSockets) socket.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
    const endpoint = new URL(url)
    const upstreamHost = endpoint.hostname
    const upstreamPort = Number(endpoint.port || 6379)
    const sockets = new Set<Socket>()
    const proxy = createServer((downstream) => {
      const upstream = connect(upstreamPort, upstreamHost)
      sockets.add(downstream)
      sockets.add(upstream)
      downstream.on('error', () => upstream.destroy())
      upstream.on('error', () => downstream.destroy())
      downstream.pipe(upstream).pipe(downstream)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy address')
    endpoint.hostname = '127.0.0.1'
    endpoint.port = String(proxyAddress.port)
    const failed = await createNodeCache({ url: endpoint.toString(), namespace, timeoutMs: 100 })
    await failed.ping()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await delay(20)
    try {
      for (const operation of [
        () => failed.rateLimiter.limit('auth', 'never-allow'),
        () => failed.kv('auth').get('session'),
        () => failed.kv('settings').put('setting', 'x'),
        () => failed.kv('models').delete('model'),
        () => failed.ping(),
      ]) {
        const error = await operation().catch((error: unknown) => error)
        expect(toErrorResponse(error)).toEqual({
          status: 503,
          body: { error: { code: 'CACHE_UNAVAILABLE', message: 'Cache is unavailable' } },
        })
      }
    } finally {
      await failed.close()
    }
  })
})
