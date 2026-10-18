import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { checkSecrets, secretRequirements } from './check-secrets.mjs'
import { waitHealthy } from './wait-healthy.mjs'

test('secret check reports the actual staging payment gaps without printing present secrets', async () => {
  const lines = []
  const missing = {
    web: ['PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
    jobs: secretRequirements.jobs.required,
  }
  const code = await checkSecrets({
    list: async (worker) =>
      [...secretRequirements[worker].required, ...secretRequirements[worker].optional]
        .filter((name) => !missing[worker].includes(name))
        .map((name) => ({ name, type: 'secret_text', value: 'must-not-print' })),
    write: (line) => lines.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(lines, [
    'web required: PAYPAL_CLIENT_SECRET',
    'web required: PAYPAL_WEBHOOK_ID',
    'jobs required: STRIPE_SECRET_KEY',
    'jobs required: STRIPE_WEBHOOK_SECRET',
    'jobs required: PAYPAL_CLIENT_ID',
    'jobs required: PAYPAL_CLIENT_SECRET',
    'jobs required: PAYPAL_WEBHOOK_ID',
  ])
})

test('optional secrets do not block an otherwise configured staging environment', async () => {
  const lines = []
  const code = await checkSecrets({
    list: async (worker) => secretRequirements[worker].required.map((name) => ({ name })),
    write: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.deepEqual(lines, [
    'web optional: RESEND_API_KEY',
    'web optional: AI_GATEWAY_TOKEN',
    'web optional: SENTRY_DSN',
    'web optional: R2_ACCESS_KEY_ID',
    'web optional: R2_SECRET_ACCESS_KEY',
    'jobs optional: RESEND_API_KEY',
    'jobs optional: AI_GATEWAY_TOKEN',
    'jobs optional: SENTRY_DSN',
  ])
})

test('secret list failure and invalid output fail closed without exposing CLI output', async () => {
  const errors = []
  const code = await checkSecrets({
    list: async (worker) => {
      if (worker === 'web') throw new Error('private CLI authentication output')
      return { raw: 'private malformed output' }
    },
    write: () => assert.fail('Failed secret listing must not invent missing secrets'),
    error: (line) => errors.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(errors, ['web: secret list failed', 'jobs: secret list failed'])
})

async function mockHealth(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}/api/health`
}

test('health waits through an old version, database downtime and non-200 before succeeding', async (t) => {
  const responses = [
    [200, { version: 'old-sha', db: { status: 'up' } }],
    [200, { version: 'new-sha', db: { status: 'down' }, private: 'connection-string' }],
    [503, { version: 'new-sha', db: { status: 'up' } }],
    [200, { version: 'new-sha', db: { status: 'up' } }],
  ]
  let requests = 0
  const url = await mockHealth(t, (_request, response) => {
    const [status, body] = responses[requests++]
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  const lines = []
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 200,
      timeoutMs: 2_000,
      write: (line) => lines.push(line),
    }),
    0,
  )
  assert.equal(requests, 4)
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { status: 200, version: 'old-sha' },
      { status: 200, version: 'new-sha' },
      { status: 503, version: 'new-sha' },
    ],
  )
})

test('wrong deployed version times out and emits only status and version', async (t) => {
  const url = await mockHealth(t, (_request, response) => {
    response.end(JSON.stringify({ version: 'old-sha', db: { status: 'up' }, secret: 'private' }))
  })
  const lines = []
  const started = performance.now()
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 20,
      timeoutMs: 100,
      write: (line) => lines.push(line),
    }),
    1,
  )
  assert.ok(performance.now() - started >= 90)
  assert.ok(lines.length >= 2)
  assert.ok(lines.filter((line) => line === '{"status":200,"version":"old-sha"}').length >= 2)
  // 总时限附近的最后一轮可在取得响应前中止，同样只能记录两个允许字段。
  assert.ok(
    lines.every(
      (line) =>
        line === '{"status":200,"version":"old-sha"}' || line === '{"status":null,"version":null}',
    ),
  )
})

test('invalid response and hanging requests stay bounded and do not reveal response or URL', async (t) => {
  let requests = 0
  const url = await mockHealth(t, (_request, response) => {
    if (requests++ === 0) response.end('private invalid response body')
  })
  const lines = []
  const started = performance.now()
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 30,
      timeoutMs: 130,
      write: (line) => lines.push(line),
    }),
    1,
  )
  assert.ok(performance.now() - started < 500)
  assert.ok(requests >= 2)
  assert.deepEqual(JSON.parse(lines[0]), { status: 200, version: null })
  assert.ok(lines.slice(1).every((line) => line === '{"status":null,"version":null}'))
})
