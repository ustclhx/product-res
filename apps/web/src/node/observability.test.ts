import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '@product-res/shared'
import { setLogContext, withLogContext } from '@product-res/shared/log'
import { notFound, redirect } from '@tanstack/react-router'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { type WebRuntime, withWebRuntime } from '../server/runtime.ts'
import { captureServerError } from '../server/sentry.ts'
import { initializeNodeObservability, nodeBeforeSend } from './observability.ts'

const release = '0123456789abcdef0123456789abcdef01234567'

it('缺 DSN/development 不加载 SDK、不初始化、不出站，Node 模块依赖图没有 CF SDK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-c-sentry-web-'))
  try {
    const outfile = join(directory, 'observer.mjs')
    const bundle = await build({
      entryPoints: ['src/node/observability.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['@sentry/node'],
      metafile: true,
    })
    expect(Object.keys(bundle.metafile?.inputs ?? {}).join('\n')).not.toContain(
      '@sentry/cloudflare',
    )
    const sdkBundle = await build({
      entryPoints: ['src/node/observability.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      metafile: true,
    })
    const inputs = Object.keys(sdkBundle.metafile?.inputs ?? {}).join('\n')
    expect(inputs).toContain('@sentry/node')
    expect(inputs).not.toContain('@sentry/cloudflare')
    const code = `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.includes('@sentry/')) throw new Error('SDK must not load')
        return next(specifier, context)
      } })
      globalThis.fetch = () => { throw new Error('Network must not run') }
      const { initializeNodeObservability } = await import(${JSON.stringify(outfile)})
      for (const config of [
        { environment: 'production', release: ${JSON.stringify(release)} },
        { dsn: 'http://fixture@127.0.0.1:1/1', environment: 'development', release: ${JSON.stringify(release)} }
      ]) {
        const observer = await initializeNodeObservability(config)
        if (observer.enabled || observer.client) throw new Error('Must be disabled')
        observer.captureError(new Error('private body'))
        if (observer.run(() => 7) !== 7) throw new Error('Business changed')
      }
      console.log('disabled-ok')
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code])
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(exit, output).toBe(0)
    expect(output).toContain('disabled-ok')
    expect(output).not.toContain('private body')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([false, true])(
  '自动异常采集与连续 fatal (%s) 保持安全 envelope 和退出码',
  async (repeat) => {
    const envelopes: string[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      envelopes.push(body)
      response.writeHead(200).end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address missing')
    // 外置 SDK 从应用 node_modules 解析；生成文件只在本用例的独占目录内。
    const directory = await mkdtemp(join(process.cwd(), 'node_modules/.sentry-fatal-'))
    try {
      const outfile = join(directory, 'fatal.mjs')
      await build({
        stdin: {
          contents: `
          import { initializeNodeObservability, nodeBeforeSend } from './src/node/observability.ts'
          import { withLogContext } from '@product-res/shared/log'
          import { makeNodeTransport } from '@sentry/node'
          import { setTimeout as delay } from 'node:timers/promises'
          const slowTransport = (options) => {
            const transport = makeNodeTransport(options)
            return { ...transport, flush: async (timeout) => {
              const result = await transport.flush(timeout)
              await delay(500)
              return result
            } }
          }
          await initializeNodeObservability({
            dsn: 'http://fixture@127.0.0.1:${address.port}/1',
            environment: 'smoke', release: '${release}'
          }, ${repeat ? 'slowTransport' : 'undefined'})
          withLogContext({requestId:'fatal-request'}, () => {
            setTimeout(() => { throw new Error('Authorization: fatal-secret-marker private-fatal-body') }, 0)
            ${repeat ? "setTimeout(() => { throw new Error('Authorization: second-fatal-secret-marker private-second-body') }, 100)" : ''}
          })
        `,
          resolveDir: process.cwd(),
          sourcefile: 'fatal-fixture.ts',
        },
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: ['@sentry/node'],
      })
      const child = spawn(process.execPath, [outfile], { timeout: 5_000 })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(exit, output).toBe(1)
      expect(envelopes).toHaveLength(1)
      const wire = envelopes.join('\n')
      expect(wire).toContain('fatal-request')
      expect(wire).toContain('INTERNAL_ERROR')
      expect(wire + output).not.toContain('fatal-secret-marker')
      expect(wire + output).not.toContain('private-fatal-body')
      expect(wire + output).not.toContain('second-fatal-secret-marker')
      expect(wire + output).not.toContain('private-second-body')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it('HTTP observer 真实 envelope 隔离空间、过滤预期异常、去重并移除所有任意正文', async () => {
  const envelopes: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    envelopes.push(body)
    response.writeHead(200).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address missing')
  const observer = await initializeNodeObservability({
    dsn: `http://fixture@127.0.0.1:${address.port}/1`,
    environment: 'smoke',
    release,
  })
  try {
    const sdk = await import('@sentry/node')
    sdk.getGlobalScope().setUser({ email: 'private@example.test' })
    sdk.getGlobalScope().setTag('jobId', 'global-job-marker')
    sdk.getGlobalScope().addAttachment({ filename: 'mail.txt', data: 'private-mail-body-marker' })
    sdk.getGlobalScope().setExtra('provider', 'smtp-password-marker')
    sdk.addBreadcrumb({ message: 'private-mail-body-marker' })
    const failure = new AppError(
      'S3_OPERATION_FAILED',
      [
        'Authorization: Bearer auth-marker Cookie: cookie-marker OTP: otp-marker',
        'https://s3.test/key?X-Amz-Signature=signature-marker&X-Amz-Credential=access-marker',
        'smtp://user:smtp-password-marker@mail.test private-mail-body-marker private-ai-body-marker',
      ].join(' '),
      { status: 503, cause: new Error('cause-password-marker') },
    )
    failure.stack +=
      '\n    at provider (https://user:stack-password-marker@s3.test/key?signature=stack-signature-marker:2:4)'
    failure.stack += '\n    at provider (file://user:stack-password-marker@host/error.js:2:4)'
    const runtime = { observability: observer } as unknown as WebRuntime
    await Promise.all(
      ['a', 'b'].map((space) =>
        withLogContext({ requestId: `request-${space}`, workspaceId: `workspace-${space}` }, () =>
          observer.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, space === 'a' ? 8 : 1))
            setLogContext({ userId: `user-${space}` })
            withWebRuntime(runtime, () => {
              captureServerError(redirect({ to: '/' }))
              captureServerError(notFound())
              captureServerError(new AppError('DENIED', 'private', { status: 403 }))
              const error = space === 'a' ? failure : new TypeError('private-ai-body-marker')
              captureServerError(error)
              // 模拟 Start middleware 与入口 catch 对同一对象的重复通知。
              observer.captureError(error)
            })
          }),
        ),
      ),
    )
    expect(await observer.client?.flush(2_000)).toBe(true)
    const events = envelopes.flatMap((body) =>
      body.split('\n').flatMap((line) => {
        const value = JSON.parse(line)
        return value.exception ? [value] : []
      }),
    )
    expect(events).toHaveLength(2)
    for (const space of ['a', 'b']) {
      const event = events.find((value) => value.tags.workspaceId === `workspace-${space}`)
      expect(event).toMatchObject({
        release,
        dist: 'web-node',
        environment: 'smoke',
        tags: { requestId: `request-${space}`, userId: `user-${space}` },
        user: { id: `user-${space}` },
      })
      expect(JSON.stringify(event)).not.toContain(`workspace-${space === 'a' ? 'b' : 'a'}`)
      expect(
        event.exception.values[0].stacktrace.frames.some((frame: { filename: string }) =>
          frame.filename.endsWith('observability.test.ts'),
        ),
      ).toBe(true)
      expect(event.breadcrumbs).toBeUndefined()
      expect(event.request).toBeUndefined()
      expect(event.extra).toBeUndefined()
    }
    expect(events.find((value) => value.tags.workspaceId === 'workspace-a').tags.code).toBe(
      'S3_OPERATION_FAILED',
    )
    const wire = envelopes.join('\n')
    for (const secret of [
      'auth-marker',
      'cookie-marker',
      'otp-marker',
      'signature-marker',
      'access-marker',
      'smtp-password-marker',
      'private-mail-body-marker',
      'private-ai-body-marker',
      'cause-password-marker',
      'stack-password-marker',
      'stack-signature-marker',
      'private@example.test',
      'global-job-marker',
    ]) {
      expect(wire).not.toContain(secret)
    }
    expect(
      observer.client?.getOptions().integrations?.map((integration) => integration.name),
    ).toEqual(['NodeUncaughtException'])
  } finally {
    await observer.client?.close(2_000)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('retains only local source-map UUID metadata and removes unsafe debug images', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef'
  const local = fileURLToPath(import.meta.url)
  const event = nodeBeforeSend(
    {
      debug_meta: {
        images: [
          { type: 'sourcemap', code_file: local, debug_id: id, body: 'private-body' },
          {
            type: 'sourcemap',
            code_file: 'https://remote/file.js?token=private-token',
            debug_id: id,
          },
          { type: 'sourcemap', code_file: local, debug_id: 'private-credential' },
          { type: 'sourcemap', code_file: '/missing/private.js', debug_id: id },
        ],
      },
    } as never,
    { originalException: new Error('private-error') },
  )
  expect(event?.debug_meta?.images).toEqual([{ type: 'sourcemap', code_file: local, debug_id: id }])
  expect(JSON.stringify(event)).not.toMatch(
    /private-body|private-token|private-credential|private-error/,
  )
})
