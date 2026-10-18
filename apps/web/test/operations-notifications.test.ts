import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { submitRefundRequest } from '@product-res/billing'
import { defineTemplateConfig } from '@product-res/config'
import {
  auditLog,
  createDb,
  member,
  organization,
  payment,
  plan,
  planPrice,
  purchase,
  refundRequest,
  scoped,
  setting,
  user,
} from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { withLogContext } from '@product-res/shared/log'
import { eq, inArray } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { handleBillingBatch } from '../../jobs/src/queues/billing.ts'
import { runAdminAction } from '../src/features/admin/action.ts'
import {
  OPERATIONS_SETTING_KEYS,
  operationsSettingsInput,
  readOperationsSettings,
  writeOperationsSettings,
} from '../src/features/admin/settings-operations.ts'
import { enqueueRefundOperations } from '../src/features/notifications/operations.ts'

it('退款已提交成功，Telegram HTTP 超时只让消息重试，重投成功且日志与审计不泄密', async () => {
  const db = createDb(env.HYPERDRIVE)
  const migrator = createDb(env.HYPERDRIVE_MIGRATOR)
  const uid = newId(),
    ws = newId(),
    planId = newId(),
    priceId = newId(),
    purchaseId = newId(),
    pid = newId()
  const token = '123456:abcdefghijklmnopqrstuvwxyz_secret'
  const webhook = 'https://discord.com/api/webhooks/123456/discord_secret'
  const original = await db
    .select()
    .from(setting)
    .where(inArray(setting.key, [...OPERATIONS_SETTING_KEYS]))
  const logs = (['log', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  )
  const http = vi.spyOn(globalThis, 'fetch')
  try {
    await db
      .insert(user)
      .values({ id: uid, name: 'Ops test', email: `${uid}@ops.test`, role: 'admin' })
    await db.insert(organization).values({ id: ws, name: 'Ops test', slug: ws })
    await db.insert(member).values({ id: newId(), userId: uid, organizationId: ws, role: 'owner' })
    await db.insert(plan).values({
      id: planId,
      key: planId,
      name: 'Ops credits',
      type: 'credit_pack',
      credits: 10,
      features: DEFAULT_FREE_FEATURES,
    })
    await db.insert(planPrice).values({
      id: priceId,
      planId,
      provider: 'stripe',
      providerPriceId: priceId,
      amount: 1000,
      currency: 'USD',
    })
    await scoped(db, ws).insert(purchase, {
      id: purchaseId,
      userId: uid,
      planId,
      planPriceId: priceId,
      provider: 'stripe',
      providerOrderId: purchaseId,
      amount: 1000,
      currency: 'USD',
    })
    await scoped(db, ws).insert(payment, {
      id: pid,
      provider: 'stripe',
      providerPaymentId: pid,
      purchaseId,
      kind: 'one_time',
      planPriceId: priceId,
      amount: 1000,
      currency: 'USD',
      paidAt: new Date(),
    })
    const input = operationsSettingsInput.parse({
      telegramBotToken: token,
      telegramChatId: '-123',
      discordWebhookUrl: webhook,
    })
    await runAdminAction(
      { db, admin: { id: uid }, ip: null },
      'setting.operations.update',
      (scope) => writeOperationsSettings(scope, input),
    )
    expect(await readOperationsSettings(db)).toEqual({
      telegramConfigured: true,
      telegramChatId: '-123',
      discordConfigured: true,
    })
    // 省略输入不会覆盖密钥；后台读接口始终只返回配置状态。
    await runAdminAction(
      { db, admin: { id: uid }, ip: null },
      'setting.operations.update',
      (scope) => writeOperationsSettings(scope, { telegramChatId: '-123' }),
    )
    const bodies: unknown[] = []
    const options = {
      db,
      providers: {},
      notify: async () => {},
      config: defineTemplateConfig({
        app: { name: 'Ops', url: 'http://localhost', supportEmail: 'help@ops.test' },
      }).billing,
    }
    const request = await submitRefundRequest(options, {
      userId: uid,
      workspaceId: ws,
      paymentId: pid,
      reason: 'Refund please',
      contactEmail: 'private@ops.test',
    })
    await withLogContext({ requestId: 'ops-request-123' }, () =>
      enqueueRefundOperations(
        db,
        {
          send: async (body) => {
            bodies.push(body)
          },
        },
        request,
      ),
    )
    expect(request.status).toBe('pending')
    expect(http).not.toHaveBeenCalled()
    expect(bodies).toEqual([
      {
        v: 1,
        requestId: 'ops-request-123',
        operations: [
          {
            event: 'refund.requested',
            sourceId: request.id,
            workspaceId: ws,
            amount: 1000,
            currency: 'USD',
          },
        ],
      },
    ])
    const enqueueAgain = vi.fn()
    const consume = async (attempts: number) => {
      const batch = createMessageBatch('events', [
        { id: 'ops-1', timestamp: new Date(), attempts, body: bodies[0] },
      ])
      await handleBillingBatch(batch, {
        config: { PAYMENT_MODE: 'test' },
        db: { business: () => db, public: () => db },
        cache: env.CACHE,
        emailQueue: {
          async send(body) {
            await env.EMAIL_QUEUE.send(body)
          },
          async sendBatch(messages) {
            await env.EMAIL_QUEUE.sendBatch(messages)
          },
        },
        eventsQueue: { send: enqueueAgain, sendBatch: vi.fn() },
      })
      return getQueueResult(batch, createExecutionContext())
    }
    // 模拟 HTTP 端点一直不响应，直到生产超时信号中止请求。
    http.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error(`Timeout ${token}`)), {
            once: true,
          })
        }),
    )
    const first = await consume(1)
    expect(first.explicitAcks).toEqual([])
    expect(first.retryMessages).toEqual([{ msgId: 'ops-1' }])
    // 发送失败仅重试当前消息，不投递新的告警而形成循环。
    http.mockRejectedValueOnce(new Error('persistent endpoint failure'))
    expect((await consume(2)).retryMessages).toEqual([{ msgId: 'ops-1' }])
    expect(enqueueAgain).not.toHaveBeenCalled()
    expect((await scoped(db, ws).findById(refundRequest, request.id)).status).toBe('pending')
    http
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    expect((await consume(3)).retryMessages).toEqual([{ msgId: 'ops-1' }])
    expect(enqueueAgain).not.toHaveBeenCalled()
    http.mockResolvedValueOnce(Response.json({ id: 'discord-message' }))
    expect((await consume(4)).explicitAcks).toEqual(['ops-1'])
    // 已成功的两个渠道在重投时都跳过。
    expect((await consume(5)).explicitAcks).toEqual(['ops-1'])
    expect(http).toHaveBeenCalledTimes(5)
    const discordBody = JSON.parse(String(http.mock.calls[4]?.[1]?.body))
    expect(discordBody.content).toContain(ws)
    expect(discordBody.content).toContain('1000 USD')
    expect(discordBody.allowed_mentions).toEqual({ parse: [] })
    const audit = await db.select().from(auditLog).where(eq(auditLog.actorUserId, uid))
    const visible = JSON.stringify({ audit, logs: logs.flatMap((spy) => spy.mock.calls) })
    expect(visible).not.toContain(token)
    expect(visible).not.toContain(webhook)
    expect(visible).not.toContain('private@ops.test')
    expect(visible).toContain('ops-request-123')
    await runAdminAction(
      { db, admin: { id: uid }, ip: null },
      'setting.operations.update',
      (scope) =>
        writeOperationsSettings(scope, {
          telegramChatId: '',
          telegramBotToken: null,
          discordWebhookUrl: null,
        }),
    )
    expect(await readOperationsSettings(db)).toEqual({
      telegramConfigured: false,
      telegramChatId: '',
      discordConfigured: false,
    })
  } finally {
    vi.restoreAllMocks()
    await db.delete(setting).where(inArray(setting.key, [...OPERATIONS_SETTING_KEYS]))
    if (original.length) await db.insert(setting).values(original)
    await migrator.delete(auditLog).where(eq(auditLog.actorUserId, uid))
    await migrator.delete(auditLog).where(eq(auditLog.workspaceId, ws))
    await scoped(db, ws).delete(refundRequest, undefined)
    await scoped(db, ws).delete(payment, undefined)
    await scoped(db, ws).delete(purchase, undefined)
    await db.delete(planPrice).where(eq(planPrice.id, priceId))
    await db.delete(plan).where(eq(plan.id, planId))
    await scoped(db, ws).delete(member, undefined)
    await db.delete(organization).where(eq(organization.id, ws))
    await db.delete(user).where(eq(user.id, uid))
  }
}, 15000)
