import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTemplateConfig } from '@product-res/config'
import { nodeEnvSchema } from '@product-res/config/node'
import { createDb, jobBatch, jobDeadLetter, jobMessage } from '@product-res/db'
import type { EmailQueueMessage } from '@product-res/email/queue'
import { createNodeQueueProducer } from '@product-res/platform/node'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import postgres from 'postgres'
import { expect, it } from 'vitest'
import { startNodeJobs } from '../src/node/runtime.ts'

async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('SMTP inbox condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

it('delivers SMTP through persistent inbox/DBOS, preserves mixed outcomes and never acks a failed sink', async () => {
  const databaseUrl = process.env.TEST_JOB_DATABASE_URL
  const valkeyUrl = process.env.TEST_VALKEY_URL
  const migratorUrl = process.env.MIGRATION_DATABASE_URL
  const control = process.env.JOBS_SMTP_CONTROL
  const port = Number(process.env.JOBS_SMTP_PORT)
  if (!databaseUrl || !valkeyUrl || !migratorUrl || !control || !port)
    throw new Error('Isolated PG/Valkey/SMTP fixtures required')
  const db = createDb(databaseUrl, { max: 3 })
  const admin = postgres(migratorUrl, { max: 1, onnotice: () => {} })
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-c-wire-smtp-'))
  const template = defineTemplateConfig({
    app: {
      name: 'Fixture',
      url: 'https://product.ezarouter.cc',
      supportEmail: 'hxl15380@gmail.com',
    },
    billing: { enabled: false },
    credits: { enabled: false },
    ai: { text: { enabled: false }, image: false, video: false },
  })
  const config = nodeEnvSchema.parse({
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
    BETTER_AUTH_SECRET: 'jobs-smtp-fixture-at-least-32-characters',
    APP_URL: 'https://product.ezarouter.cc',
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: port,
    SMTP_TLS_MODE: 'none',
    EMAIL_FROM: 'Fixture <fixture@example.com>',
    EMAIL_REPLY_TO: 'hxl15380@gmail.com',
    SHUTDOWN_TIMEOUT_MS: 3_000,
  })
  const key = newId()
  const email = (name: string): EmailQueueMessage => ({
    v: 1,
    template: 'otp',
    props: { otp: '123456', purpose: 'sign-in', expiresInMinutes: 5 },
    to: `${name}@example.com`,
    appName: 'Fixture',
    idempotencyKey: `${key}-${name}`,
    requestId: `smtp-${name}`,
  })
  const producer = createNodeQueueProducer<EmailQueueMessage>(db, 'product-res-email').producer
  let runtime: Awaited<ReturnType<typeof startNodeJobs>> | undefined
  try {
    await db.delete(jobDeadLetter)
    await db.delete(jobMessage)
    runtime = await startNodeJobs(config, {
      host: '127.0.0.1',
      port: 0,
      executorId: `smtp-${key}`,
      ownershipDirectory: directory,
      applicationVersion: 'smtp-integration-v1',
      template,
    })
    // 一个持久批次内，成功、无效、暂时失败与永久失败分别确认/重试/DLQ。
    await producer.sendBatch([
      ...['success', 'retry', 'permanent'].map((name) => ({ body: email(name) })),
      { body: { invalid: true } as unknown as EmailQueueMessage },
    ])
    await until(async () => {
      const rows = await db.select().from(jobMessage)
      return rows.length === 4 && rows.filter((row) => row.state === 'acked').length === 3
    }, 50_000)
    const rows = await db.select().from(jobMessage)
    expect(rows.find((row) => row.idempotencyKey === `${key}-retry`)).toMatchObject({
      attempts: 2,
      state: 'acked',
    })
    expect(rows.find((row) => row.idempotencyKey === `${key}-success`)).toMatchObject({
      attempts: 1,
      state: 'acked',
    })
    expect(rows.find((row) => row.idempotencyKey === `${key}-permanent`)).toMatchObject({
      attempts: 1,
      state: 'dead',
    })
    expect(await db.select().from(jobDeadLetter)).toEqual([
      expect.objectContaining({ code: 'EMAIL_NON_RETRYABLE', attempts: 1 }),
    ])
    expect((await db.select().from(jobBatch)).some((batch) => batch.state === 'completed')).toBe(
      true,
    )
    const accepted = (await (await fetch(control)).json()) as {
      attempts: Record<string, number>
      messages: { recipient: string; raw: string }[]
    }
    expect(accepted.attempts).toMatchObject({ success: 1, retry: 2, permanent: 1 })
    expect(accepted.messages).toHaveLength(2)
    for (const message of accepted.messages) {
      expect(message.raw).toContain('multipart/alternative')
      expect(message.raw).toMatch(/Message-ID:\s*<[a-f0-9]{64}@smtp.saas.invalid>/i)
      expect(message.raw).toContain('Reply-To: hxl15380@gmail.com')
    }
    // 只构造已尝试五次的持久状态来核验第六次边界；完整退避时间轴仍归 B。
    await producer.send(email('exhausted'), { delaySeconds: 60 })
    await db
      .update(jobMessage)
      .set({ attempts: 5, availableAt: new Date() })
      .where(eq(jobMessage.idempotencyKey, `${key}-exhausted`))
    await until(async () => (await db.select().from(jobDeadLetter)).length === 2)
    expect((await db.select().from(jobDeadLetter)).find((row) => row.attempts === 6)).toMatchObject(
      {
        code: 'EMAIL_ATTEMPTS_EXHAUSTED',
        retryable: 1,
      },
    )
    // 真实 PostgreSQL 失败注入只影响这条死信；生产 app 权限和 retry/retention 配置不变。
    await producer.send(email('sink'), { delaySeconds: 60 })
    const [sink] = await db
      .select()
      .from(jobMessage)
      .where(eq(jobMessage.idempotencyKey, `${key}-sink`))
    if (!sink) throw new Error('Missing fixture sink message')
    await admin.unsafe(`CREATE FUNCTION job_engine.fixture_reject_smtp_dlq() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.message_id = '${sink.id}'::uuid THEN RAISE EXCEPTION 'fixture DLQ unavailable'; END IF;
        RETURN NEW;
      END $$`)
    await admin.unsafe(`CREATE TRIGGER fixture_reject_smtp_dlq BEFORE INSERT ON job_engine.dead_letter
      FOR EACH ROW EXECUTE FUNCTION job_engine.fixture_reject_smtp_dlq()`)
    await db.update(jobMessage).set({ availableAt: new Date() }).where(eq(jobMessage.id, sink.id))
    await producer.send(email('sink-companion'))
    await until(async () => {
      const outcome = await db
        .select()
        .from(jobMessage)
        .where(inArray(jobMessage.idempotencyKey, [`${key}-sink`, `${key}-sink-companion`]))
      return (
        outcome.some((row) => row.id === sink.id && row.attempts > 0) &&
        outcome.some((row) => row.state === 'acked')
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const [unconfirmed] = await db.select().from(jobMessage).where(eq(jobMessage.id, sink.id))
    expect(unconfirmed?.state).not.toBe('acked')
    expect(unconfirmed?.state).not.toBe('dead')
    expect((await db.select().from(jobDeadLetter)).some((row) => row.messageId === sink.id)).toBe(
      false,
    )
  } finally {
    await runtime?.shutdown()
    await admin.unsafe('DROP TRIGGER IF EXISTS fixture_reject_smtp_dlq ON job_engine.dead_letter')
    await admin.unsafe('DROP FUNCTION IF EXISTS job_engine.fixture_reject_smtp_dlq()')
    await admin.end()
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 75_000)
