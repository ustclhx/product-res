import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeEnvSchema } from '@product-res/config/node'
import { createDb, jobDeadLetter, jobMessage } from '@product-res/db'
import { withNodeRequestContext } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { expect, it, vi } from 'vitest'
import { startNodeJobs } from '../../../jobs/src/node/runtime.ts'
import { createNodeWebProcess } from '../../src/node/runtime.ts'
import { templateConfig } from '../../src/server/template-config.ts'

// 只替换模板开关；实际 Node 认证工厂、生产者、consumer 和持久队列保持生产实现。
vi.mock('../../src/server/template-config.ts', async () => {
  const { defineTemplateConfig } = await import('@product-res/config')
  return {
    templateConfig: defineTemplateConfig({
      app: {
        name: 'Auth SMTP fixture',
        url: 'http://localhost:3000',
        supportEmail: 'support@example.test',
      },
      auth: { turnstile: false, oauth: [], requireEmailVerification: true },
      billing: { providers: [], signupBonusCredits: 0 },
      ai: { text: { enabled: false }, image: false, video: false },
    }),
  }
})

type Capture = {
  mode: string
  attempts: { recipient: string; at: string; mode: string }[]
  messages: { recipient: string; raw: string; messageId: string; acceptedAt: string }[]
}

async function until(check: () => Promise<boolean>, timeout = 50_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Auth SMTP condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// 从实际收件的 text/plain MIME 提取链接；不读取 inbox body 或 verification 表中的 token。
function deliveredLink(raw: string, pathname: string) {
  const text = raw.split(/Content-Type: text\/plain[^\r\n]*\r\n/i)[1]?.split(/\r\n--/)[0]
  if (!text) throw new Error('Delivered text/plain part missing')
  const decoded = text
    .replace(/=\r\n/g, '')
    .replace(/=([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  const link = decoded
    .match(/https?:\/\/[^\s<>]+/g)
    ?.find((value) => new URL(value).pathname.startsWith(pathname))
  if (!link) throw new Error('Delivered authentication link missing')
  return new URL(link)
}

it('completes registration and password reset over HTTP with durable SMTP retries and duplicate identity', async () => {
  const databaseUrl = process.env.TEST_JOB_DATABASE_URL
  const valkeyUrl = process.env.TEST_VALKEY_URL
  const control = process.env.JOBS_SMTP_CONTROL
  const smtpPort = Number(process.env.JOBS_SMTP_PORT)
  if (!databaseUrl || !valkeyUrl || !control || !smtpPort)
    throw new Error('Isolated PG/Valkey/SMTP required; use run-auth-smtp.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-c-verify-auth-'))
  const db = createDb(databaseUrl, { max: 2 })
  let web: Awaited<ReturnType<typeof createNodeWebProcess>> | undefined
  let jobs: Awaited<ReturnType<typeof startNodeJobs>> | undefined
  const certPath = process.env.AUTH_SMTP_TLS_CERT
  const keyPath = process.env.AUTH_SMTP_TLS_KEY
  if (!certPath || !keyPath) throw new Error('Temporary trusted TLS fixture required')
  const server = createServer(
    { cert: await readFile(certPath), key: await readFile(keyPath) },
    async (incoming, outgoing) => {
      try {
        let body = ''
        for await (const chunk of incoming) body += String(chunk)
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const request = new Request(`${base}${incoming.url}`, {
          method: incoming.method ?? 'GET',
          headers,
          ...(body ? { body } : {}),
        })
        if (!web) throw new Error('HTTP fixture not ready')
        const processWeb = web
        const metadata = processWeb.metadata(request, incoming.socket.remoteAddress)
        const response = await withNodeRequestContext(metadata, () =>
          processWeb.requestRuntime(metadata).handleAuthRequest(request),
        )
        if (!response) throw new Error('Auth response missing')
        outgoing.writeHead(response.status, {
          ...Object.fromEntries(response.headers),
          'set-cookie': response.headers.getSetCookie(),
          'x-request-id': metadata.requestId,
        })
        outgoing.end(await response.text())
      } catch {
        outgoing.writeHead(500).end('HTTP fixture failed')
      }
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const email = `${newId()}@auth-smtp.example.test`
  const password = 'correct-horse-battery-staple'
  const newPassword = 'new-correct-horse-battery-staple'
  const snapshot = async () => (await (await fetch(control)).json()) as Capture
  const mode = async (value: string) => {
    expect((await fetch(`${control}/${value}`, { method: 'POST' })).status).toBe(200)
  }
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
      redirect: 'manual',
    })
  const startedAt = new Date().toISOString()
  const config = nodeEnvSchema.parse({
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
    BETTER_AUTH_SECRET: 'auth-smtp-fixture-at-least-32-characters',
    APP_URL: base,
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: smtpPort,
    SMTP_TLS_MODE: 'none',
    EMAIL_FROM: 'Fixture <fixture@example.test>',
    EMAIL_REPLY_TO: 'support@example.test',
    CACHE_NAMESPACE: newId(),
    SHUTDOWN_TIMEOUT_MS: 5000,
  })
  const outgoingFetch = vi.spyOn(globalThis, 'fetch')
  try {
    web = await createNodeWebProcess(config)
    jobs = await startNodeJobs(config, {
      host: '127.0.0.1',
      port: 0,
      executorId: `auth-${newId()}`,
      ownershipDirectory: directory,
      applicationVersion: 'auth-smtp-e2e-v1',
      template: templateConfig,
    })
    await mode('temporary')
    const registered = await post('/sign-up/email', { email, password, name: 'SMTP fixture' })
    expect(registered.status).toBe(200)
    const registrationRequestId = registered.headers.get('x-request-id')
    await until(async () => {
      const rows = await db.select().from(jobMessage)
      return rows.length === 1 && rows[0]?.state === 'pending' && rows[0].attempts === 1
    })
    expect((await snapshot()).messages.length).toBe(0)
    const [registrationPending] = await db.select().from(jobMessage)
    if (!registrationPending) throw new Error('Registration inbox missing')
    expect(registrationPending.requestId).toBe(registrationRequestId)
    // 保留生产首次失败后 30 秒退避，不修改 availableAt、attempts 或队列策略。
    await mode('accept')
    await until(async () => (await db.select().from(jobMessage))[0]?.state === 'acked')
    const registrationCapture = (await snapshot()).messages[0]
    if (!registrationCapture) throw new Error('Registration SMTP receipt missing')
    expect(/^<[a-f0-9]{64}@smtp\.saas\.invalid>$/.test(registrationCapture.messageId)).toBe(true)
    const verifyLink = deliveredLink(registrationCapture.raw, '/api/auth/verify-email')
    expect(verifyLink.origin === base).toBe(true)
    const verified = await fetch(verifyLink, { redirect: 'manual' })
    expect([200, 302].includes(verified.status)).toBe(true)
    const signedIn = await post('/sign-in/email', { email, password })
    expect(signedIn.status).toBe(200)
    expect(
      ((await signedIn.json()) as { user: { emailVerified: boolean } }).user.emailVerified,
    ).toBe(true)
    const oldCookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .filter((value) => value && !value.includes('session_data'))
      .join('; ')

    await mode('drop-confirmation-once')
    const reset = await post('/request-password-reset', { email, redirectTo: `${base}/reset` })
    expect(reset.status).toBe(200)
    const resetRequestId = reset.headers.get('x-request-id')
    await until(async () => {
      const rows = await db.select().from(jobMessage)
      return rows.some(
        (row) => row.requestId === resetRequestId && row.state === 'pending' && row.attempts === 1,
      )
    })
    const ambiguousCapture = await snapshot()
    expect(ambiguousCapture.messages.length).toBe(2)
    await until(async () =>
      (await db.select().from(jobMessage)).some(
        (row) => row.requestId === resetRequestId && row.state === 'acked' && row.attempts === 2,
      ),
    )
    const captured = await snapshot()
    expect(captured.messages.length).toBe(3)
    const firstReset = captured.messages[1]
    const retryReset = captured.messages[2]
    if (!firstReset || !retryReset) throw new Error('Reset SMTP receipts missing')
    expect(firstReset.messageId).toBe(retryReset.messageId)
    const resetLink = deliveredLink(retryReset.raw, '/api/auth/reset-password/')
    const originalLink = deliveredLink(firstReset.raw, '/api/auth/reset-password/')
    expect(resetLink.href === originalLink.href).toBe(true)
    const followed = await fetch(resetLink, { redirect: 'manual' })
    expect(followed.status).toBe(302)
    const location = followed.headers.get('location')
    if (!location) throw new Error('Reset link redirect missing')
    const redirect = new URL(location, base)
    expect(redirect.origin === base).toBe(true)
    const token = redirect.searchParams.get('token')
    expect(Boolean(token)).toBe(true)
    expect((await post('/reset-password', { token, newPassword })).status).toBe(200)
    expect((await post('/sign-in/email', { email, password })).status).toBe(401)
    expect((await post('/sign-in/email', { email, password: newPassword })).status).toBe(200)
    const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: oldCookie } })
    expect((await session.json()) === null).toBe(true)
    const rows = await db.select().from(jobMessage)
    expect(rows.length).toBe(2)
    expect(rows.every((row) => row.state === 'acked' && row.attempts === 2)).toBe(true)
    expect((await db.select().from(jobDeadLetter)).length).toBe(0)
    const resendCalls = outgoingFetch.mock.calls.filter(([input]) => {
      const url = input instanceof Request ? input.url : String(input)
      return new URL(url).hostname === 'api.resend.com'
    })
    expect(resendCalls.length).toBe(0)
    // 证据只保留安全身份和状态，绝不保存邮件正文、链接、token、密码或连接串。
    const evidence = {
      task: '3.4',
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      startedAt,
      completedAt: new Date().toISOString(),
      target: 'real Node HTTP / source composition / persistent inbox / DBOS / Docker SMTP',
      command: 'node apps/web/test/node/run-auth-smtp.mjs',
      registration: {
        requestId: registrationRequestId,
        inboxId: registrationPending.id,
        messageId: registrationCapture.messageId,
        attempts: 2,
        status: 'acked',
        httpStatus: registered.status,
        verifiedByDeliveredLink: true,
      },
      passwordReset: {
        requestId: resetRequestId,
        inboxId: rows.find((row) => row.requestId === resetRequestId)?.id,
        messageId: firstReset.messageId,
        receiptCount: 2,
        acceptedAt: [firstReset.acceptedAt, retryReset.acceptedAt],
        attempts: 2,
        status: 'acked',
        httpStatus: reset.status,
        resetByDeliveredLink: true,
        originalSessionRevoked: true,
      },
      fault: 'SMTP server retained full DATA then disconnected before final 250',
      resendCalls: 0,
      warning:
        'SMTP permits duplicate delivery; stable Message-ID is identity, not idempotence or exactly-once',
    }
    const evidencePath = fileURLToPath(
      new URL('../../../../docs/runbooks/evidence/selfhost/c-3.4-auth-smtp.json', import.meta.url),
    )
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  } finally {
    outgoingFetch.mockRestore()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await jobs?.shutdown()
    await web?.close()
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
