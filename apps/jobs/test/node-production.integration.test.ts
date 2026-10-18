import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { type AddressInfo, connect, createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLocalEnv } from '@product-res/db/worktree-env'
import { expect, it } from 'vitest'

it('runs production jobs without workerd and exits gracefully with a residual HTTP socket', async () => {
  const databaseUrl =
    readLocalEnv('TEST_DATABASE_URL') ??
    readLocalEnv('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE')
  const valkeyUrl = process.env.TEST_VALKEY_URL
  if (!databaseUrl || !valkeyUrl) throw new Error('TEST_DATABASE_URL and TEST_VALKEY_URL required')
  const root = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(join(root, '.output'), { recursive: true })
  const directory = await mkdtemp(join(root, '.output/production-test-'))
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as AddressInfo).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  execFileSync(process.execPath, ['scripts/build-node.mjs', directory], { cwd: root })
  const child = spawn(process.execPath, [join(directory, 'server/index.mjs')], {
    cwd: directory,
    env: {
      DATABASE_URL: databaseUrl,
      VALKEY_URL: valkeyUrl,
      BETTER_AUTH_SECRET: 'jobs-production-fixture-at-least-32-characters',
      APP_URL: 'https://product.ezarouter.cc',
      GOOGLE_CLIENT_ID: 'fixture',
      GOOGLE_CLIENT_SECRET: 'fixture',
      GITHUB_CLIENT_ID: 'fixture',
      GITHUB_CLIENT_SECRET: 'fixture',
      TURNSTILE_SITE_KEY: 'fixture',
      TURNSTILE_SECRET_KEY: 'fixture',
      HOST: '127.0.0.1',
      PORT: String(port),
      SHUTDOWN_TIMEOUT_MS: '1000',
      JOB_EXECUTOR_ID: 'jobs-production-fixture',
      JOB_OWNERSHIP_DIRECTORY: join(directory, 'owners'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = once(child, 'exit')
  let socket: ReturnType<typeof connect> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Jobs startup timeout')), 8_000)
      let output = ''
      child.stdout.on('data', (data) => {
        output += String(data)
        if (output.includes('jobs.node.started')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Jobs exited before listen'))
      })
    })
    const response = await fetch(`http://127.0.0.1:${port}/internal/live`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      version: expect.stringMatching(/^[a-f0-9]{40}$/),
    })
    const ready = await fetch(`http://127.0.0.1:${port}/internal/ready`)
    expect([200, 503]).toContain(ready.status)
    expect(await ready.json()).toMatchObject({
      queue: { status: expect.stringMatching(/^(up|down)$/) },
      scheduler: { status: expect.stringMatching(/^(up|down)$/) },
    })
    socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write('GET /internal/live HTTP/1.1\r\n')
    child.kill('SIGTERM')
    expect(await exit).toEqual([0, null])
  } finally {
    socket?.destroy()
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await exit
    }
    await rm(directory, { recursive: true, force: true })
  }
})
