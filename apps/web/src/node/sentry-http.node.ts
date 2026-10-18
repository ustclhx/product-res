import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import { newId } from '@product-res/shared'
import { expect, it, vi } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const databaseUrl = process.env.NODE_STORAGE_DATABASE_URL
if (!databaseUrl) throw new Error('Isolated Node observer database required')

for (const mode of ['reachable', 'stalled', 'disabled']) {
  it(`captures real production HTTP errors and stops within the existing deadline: ${mode}`, async () => {
    const db = createDb(databaseUrl, { max: 2 })
    const secret = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    )
    const appUrl = 'https://product.ezarouter.cc'
    const events: {
      tags: Record<string, string>
      user?: { id: string }
      release: string
      dist: string
      debug_meta: { images: { type: string; code_file: string; debug_id: string }[] }
    }[] = []
    const connections = new Set<Socket>()
    const transport = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      const data = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      for (const line of data.toString().split('\n')) {
        try {
          const value = JSON.parse(line)
          if (value.exception) events.push(value)
        } catch {
          /* envelope 中也有非 JSON 项 */
        }
      }
      if (mode !== 'stalled') response.end('{}')
    })
    transport.on('connection', (socket) => {
      connections.add(socket)
      socket.on('close', () => connections.delete(socket))
    })
    let child: ChildProcess | undefined
    let exit: Promise<unknown[]> | undefined
    let logs = ''
    try {
      const auth = createAuth({ APP_URL: appUrl, BETTER_AUTH_SECRET: secret }, db, {
        config: defineTemplateConfig({
          app: { name: 'Observer fixture', url: appUrl, supportEmail: 'hxl15380@gmail.com' },
          auth: { oauth: [], turnstile: false },
        }),
        sendEmail: async () => {},
      })
      const identities = []
      for (let index = 0; index < 2; index++) {
        const signed = await auth.handler(
          new Request(`${appUrl}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { origin: appUrl, 'content-type': 'application/json' },
            body: JSON.stringify({
              email: `${newId()}@observer.example`,
              password: 'correct-horse-battery-staple',
              name: 'Observer fixture',
            }),
          }),
        )
        expect(signed.status).toBe(200)
        const id = ((await signed.json()) as { user: { id: string } }).user.id
        await db.$client`update "user" set role = 'admin' where id = ${id}`
        identities.push({
          id,
          cookie: signed.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; '),
        })
      }
      transport.listen(0, '127.0.0.1')
      await once(transport, 'listening')
      const transportPort = (transport.address() as AddressInfo).port
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const port = (probe.address() as AddressInfo).port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      const base = `http://127.0.0.1:${port}`
      child = spawn(process.execPath, ['.output/server/index.mjs'], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: databaseUrl,
          VALKEY_URL: process.env.TEST_VALKEY_URL,
          BETTER_AUTH_SECRET: secret,
          APP_URL: appUrl,
          GOOGLE_CLIENT_ID: 'fixture',
          GOOGLE_CLIENT_SECRET: 'fixture',
          GITHUB_CLIENT_ID: 'fixture',
          GITHUB_CLIENT_SECRET: 'fixture',
          TURNSTILE_SITE_KEY: 'fixture',
          TURNSTILE_SECRET_KEY: 'fixture',
          CACHE_NAMESPACE: `observer-${newId()}`,
          HOST: '127.0.0.1',
          PORT: String(port),
          SHUTDOWN_TIMEOUT_MS: '1500',
          ...(mode === 'disabled'
            ? {}
            : {
                SENTRY_DSN: `http://fixture@127.0.0.1:${transportPort}/1`,
                SENTRY_ENVIRONMENT: 'smoke',
              }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk) => {
        logs += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        logs += String(chunk)
      })
      exit = once(child, 'exit')
      await vi.waitFor(
        async () => {
          if (child?.exitCode !== null) throw new Error('Observer production startup failed')
          expect(
            await fetch(`${base}/internal/live`).then(
              (response) => response.status,
              () => 0,
            ),
          ).toBe(200)
        },
        { timeout: 10_000 },
      )
      const responses = await Promise.all(
        identities.map((identity) =>
          fetch(`${base}/api/admin/observability/sentry-test`, {
            method: 'POST',
            headers: { origin: appUrl, cookie: identity.cookie },
          }),
        ),
      )
      expect(responses.map((response) => response.status)).toEqual(
        mode === 'disabled' ? [503, 503] : [500, 500],
      )
      if (mode !== 'disabled') await vi.waitFor(() => expect(events).toHaveLength(2))
      const started = Date.now()
      child.kill('SIGTERM')
      const outcome = await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
      ])
      expect(outcome).not.toBe('timeout')
      expect(Date.now() - started).toBeLessThan(2_500)
      expect(outcome).toEqual([0, null])
      if (mode === 'disabled') expect(events).toEqual([])
      else {
        expect(events.map((event) => event.user?.id).sort()).toEqual(
          identities.map((identity) => identity.id).sort(),
        )
        for (let index = 0; index < 2; index++) {
          expect(events).toContainEqual(
            expect.objectContaining({
              tags: expect.objectContaining({
                requestId: responses[index]?.headers.get('x-request-id'),
                userId: identities[index]?.id,
              }),
              release: expect.stringMatching(/^[a-f0-9]{40}$/),
              dist: 'web-node',
            }),
          )
        }
        for (const event of events) {
          expect(event.debug_meta.images.length).toBeGreaterThan(0)
          for (const image of event.debug_meta.images) {
            const source = image.code_file.startsWith('file://')
              ? fileURLToPath(image.code_file)
              : image.code_file
            const map = JSON.parse(await readFile(`${source}.map`, 'utf8'))
            expect(image.debug_id).toBe(map.debugId)
            expect(image).toEqual({
              type: 'sourcemap',
              code_file: expect.any(String),
              debug_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
            })
          }
        }
        expect(JSON.stringify(events)).not.toContain('Sentry verification')
        expect(logs.includes(secret)).toBe(false)
        expect(logs).not.toContain('Sentry verification')
      }
    } finally {
      if (child?.exitCode === null) {
        child.kill('SIGKILL')
        await exit
      }
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => transport.close(() => resolve()))
      await db.close()
    }
  }, 20_000)
}
