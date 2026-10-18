import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import type { EmailQueueMessage } from '@product-res/email/queue'
import { createNodeQueueProducer } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))

it('triggers one audited admin HTTP error and one durable SMTP job failure in the authorized project', async () => {
  const databaseUrl = process.env.TEST_JOB_DATABASE_URL
  const valkeyUrl = process.env.TEST_VALKEY_URL
  const rawDsn = process.env.SENTRY_DSN
  if (!databaseUrl || !valkeyUrl || !rawDsn)
    throw new Error('Isolated probe configuration required')
  // 本地 DSN 带末尾路径分隔符；按 URL 规范化并去掉末尾斜杠，仍指向同一数字项目。
  const dsnUrl = new URL(rawDsn)
  dsnUrl.pathname = dsnUrl.pathname.replace(/\/$/, '')
  const dsn = dsnUrl.href
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim()
  const release = sha
  for (const app of ['web', 'jobs']) {
    const metadata = JSON.parse(
      await readFile(join(repository, `apps/${app}/.output/node-build.json`), 'utf8'),
    )
    expect(metadata.release).toBe(sha)
  }
  const db = createDb(databaseUrl, { max: 2 })
  const secret = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const appUrl = 'https://product.ezarouter.cc'
  const children: { child: ChildProcess; exited: Promise<unknown[]>; logs: () => string }[] = []
  async function start(app: 'web' | 'jobs') {
    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Probe port unavailable')
    const port = address.port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    const child = spawn(process.execPath, ['.output/server/index.mjs'], {
      cwd: join(repository, `apps/${app}`),
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        VALKEY_URL: valkeyUrl,
        BETTER_AUTH_SECRET: secret,
        APP_URL: appUrl,
        GOOGLE_CLIENT_ID: 'fixture',
        GOOGLE_CLIENT_SECRET: 'fixture',
        GITHUB_CLIENT_ID: 'fixture',
        GITHUB_CLIENT_SECRET: 'fixture',
        TURNSTILE_SITE_KEY: 'fixture',
        TURNSTILE_SECRET_KEY: 'fixture',
        CACHE_NAMESPACE: `sentry-probe-${newId()}`,
        HOST: '127.0.0.1',
        PORT: String(port),
        SHUTDOWN_TIMEOUT_MS: '5000',
        SENTRY_DSN: dsn,
        SENTRY_ENVIRONMENT: 'smoke',
        EMAIL_TRANSPORT: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: process.env.JOBS_SMTP_PORT,
        SMTP_TLS_MODE: 'none',
        EMAIL_FROM: 'fixture@example.com',
        JOB_EXECUTOR_ID: `sentry-local-${newId()}`,
        JOB_OWNERSHIP_DIRECTORY: join(repository, 'apps/jobs/.output/sentry-local-owners'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        output += String(chunk)
      })
    const tracked = { child, exited: once(child, 'exit'), logs: () => output }
    children.push(tracked)
    await until(async () => {
      if (child.exitCode !== null) {
        const fields = [...output.matchAll(/"(?:fields|missing|invalid)":\[([^\]]*)\]/g)].flatMap(
          (match) => match[1]?.match(/"[A-Z_]+"/g) ?? [],
        )
        throw new Error(`Production ${app} probe startup failed; fields: ${fields.join(',')}`)
      }
      return fetch(`http://127.0.0.1:${port}/internal/live`).then(
        (r) => r.ok,
        () => false,
      )
    })
    return { ...tracked, base: `http://127.0.0.1:${port}` }
  }
  try {
    // 用既有认证工厂创建本地验证过的 bootstrap 管理员；角色提升与审计由应用完成。
    const email = `${newId()}@sentry-fixture.example`
    let verificationUrl: string | undefined
    const auth = createAuth(
      { APP_URL: appUrl, BETTER_AUTH_SECRET: secret, BOOTSTRAP_ADMIN_EMAILS: email },
      db,
      {
        config: defineTemplateConfig({
          app: { name: 'Sentry fixture', url: appUrl, supportEmail: 'hxl15380@gmail.com' },
          auth: { oauth: [], turnstile: false, requireEmailVerification: true },
        }),
        sendEmail: async (message) => {
          if (message.type === 'verify-email') verificationUrl = message.url
        },
      },
    )
    async function authPost(path: string, body: unknown) {
      return auth.handler(
        new Request(`${appUrl}/api/auth/${path}`, {
          method: 'POST',
          headers: { origin: appUrl, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    }
    expect(
      (await authPost('sign-up/email', { email, password: secret, name: 'Sentry fixture' })).status,
    ).toBe(200)
    if (!verificationUrl) throw new Error('Admin fixture verification was not produced')
    expect((await auth.handler(new Request(verificationUrl))).status).toBeLessThan(400)
    const signed = await authPost('sign-in/email', { email, password: secret })
    expect(signed.status).toBe(200)
    const cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ')
    const userId = ((await signed.json()) as { user: { id: string } }).user.id
    const web = await start('web')
    const jobs = await start('jobs')
    const webAt = new Date().toISOString()
    const response = await fetch(`${web.base}/api/admin/observability/sentry-test`, {
      method: 'POST',
      headers: { origin: appUrl, cookie },
    })
    expect(response.status).toBe(500)
    const webRequestId = response.headers.get('x-request-id')
    expect(webRequestId).toBeTruthy()
    const audits =
      await db.$client`select id from audit_log where action = 'observability.sentry-test' and actor_user_id = ${userId}`
    expect(audits).toHaveLength(1)
    expect((await fetch(`${web.base}/index.mjs.map`)).status).toBe(404)
    const requestId = newId()
    const identity = `sentry-local-${newId()}`
    const jobsAt = new Date().toISOString()
    await createNodeQueueProducer<EmailQueueMessage>(db, 'email').producer.send({
      v: 1,
      template: 'otp',
      to: 'permanent@example.com',
      appName: 'Fixture',
      props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 },
      idempotencyKey: identity,
      requestId,
    })
    let messageId: string | undefined
    await until(async () => {
      const rows =
        await db.$client`select id, state from job_engine.message where idempotency_key = ${identity}`
      messageId = rows[0]?.id
      return rows[0]?.state === 'dead'
    })
    expect(jobs.logs()).toContain('email.failed')
    for (const entry of children) {
      entry.child.kill('SIGTERM')
      expect(await entry.exited).toEqual([0, null])
      expect(entry.logs()).not.toContain(dsn)
      expect(entry.logs()).not.toContain(secret)
    }
    const evidence = {
      status: 'triggered-awaiting-coordinator-ui-verification',
      buildSourceSha: sha,
      release,
      environment: 'smoke',
      environmentNote:
        'Coordinator selected existing smoke gate for local Node acceptance; no production configuration changes',
      sourceMapUpload: { status: 'completed-before-trigger', dists: ['web-node', 'jobs-node'] },
      web: {
        dist: 'web-node',
        requestId: webRequestId,
        triggeredAt: webAt,
        httpStatus: response.status,
        audited: true,
        expectedSource: 'apps/web/src/server/sentry-test.ts',
      },
      jobs: {
        dist: 'jobs-node',
        requestId,
        messageId,
        idempotencyKey: identity,
        triggeredAt: jobsAt,
        failure: 'SMTP permanent 550 from isolated fixture',
        inboxState: 'dead',
        expectedSource: 'packages/email/src/node/smtp.ts',
      },
      publicMaps: '404',
      credentialsInApplication: 'DSN only; upload token/org/project excluded',
      remaining: [
        'Confirm both events are ingested',
        'Confirm release, dist, requestId and readable TypeScript source frames',
        'Inspect event JSON for redaction and duplicate events',
      ],
    }
    const directory = join(repository, 'docs/runbooks/evidence/selfhost')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'c-2.5-sentry-node-trigger.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    )
    console.log(
      JSON.stringify({
        release,
        webRequestId,
        jobsRequestId: requestId,
        messageId,
        status: evidence.status,
      }),
    )
  } finally {
    for (const entry of children)
      if (entry.child.exitCode === null) {
        entry.child.kill('SIGKILL')
        await entry.exited
      }
    await db.close()
  }
})

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Local probe timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
