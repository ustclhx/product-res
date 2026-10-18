// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: 手动探针不经 Turbo，凭据只从进程环境读取。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// 仅显式运行此探针会发送一条真实事件；不新增公开应用路由，也不修改开发环境开关。
// 凭据由 node --env-file=<被忽略的 .env.local> 传入，不进入命令参数、临时文件或输出。
const root = fileURLToPath(new URL('../', import.meta.url))
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url))
const requireWrangler = createRequire(requireWeb.resolve('wrangler/package.json'))
const { build } = await import(requireWeb.resolve('esbuild'))
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import(
  requireWrangler.resolve('miniflare')
)
for (const key of ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'])
  assert(process.env[key], `Missing ${key}`)
const release = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const requestId = crypto.randomUUID()
const output = await build({
  stdin: {
    resolveDir: `${root}/apps/web`,
    contents: `
      import { sentryOptions } from './src/server/cloudflare/sentry.ts'
      import { withLogContext } from '@product-res/shared/log'
      import { createTransport, getIsolationScope, withSentry } from '@sentry/cloudflare'
      const worker = withSentry(env => ({
        ...sentryOptions(env),
        transport: options => createTransport(options, async ({ body }) => {
          const response = await env.SENTRY_SEND.fetch(new Request(options.url, { method: 'POST', body }))
          return { statusCode: response.status, headers: {
            'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
            'retry-after': response.headers.get('retry-after'),
          } }
        }),
      }), { async fetch(request, env, ctx) {
        getIsolationScope().addEventProcessor(async event => {
          await env.REPORT_EVENT.fetch(new Request('https://probe.invalid', { method: 'POST', body: event.event_id }))
          return event
        })
        throw new Error('Sentry verification: local explicit worker probe')
      } })
      export default { fetch(request, env, ctx) {
        return withLogContext({ requestId: env.REQUEST_ID }, async () => {
          try { return await worker.fetch(request, env, ctx) }
          catch { return new Response('Expected test failure', { status: 500 }) }
        })
      } }
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['node:*', 'cloudflare:*'],
  define: { __APP_VERSION__: JSON.stringify(release) },
  logLevel: 'silent',
})
let eventId
let ingestionStatus
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    log: new Log(LogLevel.NONE),
    bindings: {
      SENTRY_DSN: process.env.SENTRY_DSN,
      SENTRY_ENVIRONMENT: 'staging',
      REQUEST_ID: requestId,
    },
    serviceBindings: {
      REPORT_EVENT: async (request) => {
        eventId = await request.text()
        return new Response('ok')
      },
      SENTRY_SEND: async (request) => {
        const body = await request.text()
        assert(
          !body.match(/fixture-secret|fixture-private-conversation/),
          'Envelope was not redacted',
        )
        const response = await fetch(request.url, { method: 'POST', body })
        ingestionStatus = response.status
        return new Response(await response.text(), {
          status: response.status,
          headers: response.headers,
        })
      },
    },
  }),
)
try {
  const response = await mf.dispatchFetch(
    'https://probe.invalid/sentry-test?token=fixture-secret',
    {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ content: 'fixture-private-conversation' }] }),
    },
  )
  assert.equal(response.status, 500)
  for (let attempt = 0; attempt < 20 && !eventId; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250))
  assert.match(eventId ?? '', /^[a-f0-9]{32}$/)
  console.log(JSON.stringify({ captured: true, release, requestId, eventId }))
  const path = [process.env.SENTRY_ORG, process.env.SENTRY_PROJECT, eventId].map(encodeURIComponent)
  let event
  let lookupStatus
  for (let attempt = 0; attempt < 24; attempt++) {
    const result = await fetch(
      `https://sentry.io/api/0/projects/${path[0]}/${path[1]}/events/${path[2]}/`,
      {
        headers: { authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}` },
      },
    )
    lookupStatus = result.status
    if (result.ok) {
      event = await result.json()
      break
    }
    if (result.status === 403) break
    assert.equal(result.status, 404, `Sentry event lookup status ${result.status}`)
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  for (let attempt = 0; attempt < 20 && !ingestionStatus; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(ingestionStatus, 200, 'Sentry ingestion did not accept the event')
  if (event) {
    assert.equal(event.release?.version, release)
    assert(event.tags.some((tag) => tag.key === 'requestId' && tag.value === requestId))
    assert(!JSON.stringify(event).match(/fixture-secret|fixture-private-conversation/))
  }
  console.log(
    JSON.stringify({
      accepted: true,
      verified: Boolean(event),
      lookupStatus,
      utc: new Date().toISOString(),
      release,
      requestId,
      eventId,
      ...(event && { redacted: true }),
    }),
  )
} finally {
  await mf.dispose()
}
