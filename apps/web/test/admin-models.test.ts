import { MODEL_CACHE_KEY } from '@product-res/ai'
import { aiModel, auditLog } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminCache, cacheValues, createAdminTestDb } from './admin-test-resources.ts'

// 只替换 Server Function 传输与请求环境；业务 handler、adminAction 与数据库保持真实。
const runtime = vi.hoisted(() => ({ env: {} as Record<string, string> }))
vi.mock('@tanstack/react-start', () => ({
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (handler: unknown) => handler,
    }
    return builder
  },
}))
vi.mock('../src/features/admin/admin.functions.ts', () => ({ adminMiddleware: {} }))
vi.mock('../src/server/runtime.ts', () => ({
  getWebRuntime: () => ({
    cache: adminCache,
    ai: { available: true, value: { config: runtime.env, workersAi: { available: true } } },
  }),
}))

import {
  copyAdminModel,
  saveAdminModel,
  setAdminModelEnabled,
} from '../src/features/ai/admin-models.functions.ts'

const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const adminId = newId()
const runId = newId().slice(-8)
const context = { db, admin: { id: adminId }, ip: '203.0.113.7' }
const faultSchema = { 'x-acceptance-fault': { mode: 'chat-before-stream' } }
type Result = { ok: true; id: string } | { ok: false; error: string }
const call = (action: unknown, data: unknown): Promise<Result> =>
  (action as (input: { context: typeof context; data: unknown }) => Promise<Result>)({
    context,
    data,
  })
const input = (changes: Record<string, unknown> = {}) => ({
  key: `acceptance-fault-${runId}-${newId().slice(-8)}`,
  kind: 'text' as const,
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 },
  paramsSchema: JSON.stringify(faultSchema),
  tags: [],
  enabled: false,
  sort: 0,
  ...changes,
})
const audits = () =>
  db.select().from(auditLog).where(eq(auditLog.actorUserId, adminId)).orderBy(auditLog.id)
const row = async (id: string) => (await db.select().from(aiModel).where(eq(aiModel.id, id)))[0]
const modelIds: string[] = []
async function create(changes: Record<string, unknown> = {}) {
  const result = await call(saveAdminModel, input(changes))
  expect(result, 'valid model fixture').toMatchObject({ ok: true })
  if (!result.ok) throw new Error(`Model fixture failed: ${result.error}`)
  modelIds.push(result.id)
  return result.id
}
async function hash(schema: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(schema)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

beforeAll(async () => {
  await db.$client`insert into "user"(id,name,email,role) values(${adminId},'Admin',${`${adminId}@admin-model-test.example`},'admin')`
})
beforeEach(() => {
  runtime.env = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'enabled' }
  cacheValues.set(MODEL_CACHE_KEY, 'unchanged')
})
afterAll(async () => {
  await migrator.$client`delete from audit_log where actor_user_id=${adminId}`
  if (modelIds.length) await db.$client`delete from ai_model where id in ${db.$client(modelIds)}`
  await db.$client`delete from "user" where id=${adminId}`
  cacheValues.delete(MODEL_CACHE_KEY)
  await Promise.all([db.$client.end(), migrator.$client.end()])
})

describe('后台故障模型配置边界', () => {
  it.each([
    { paramsSchema: '{}' },
    { paramsSchema: JSON.stringify({ 'x-acceptance-fault': { mode: 'unknown' } }) },
    { key: `normal-${runId}` },
    { provider: 'openai' },
    { providerModelId: 'different-model' },
    { kind: 'image', provider: 'fal', providerModelId: 'fal-ai/flux/schnell' },
  ])('保存非法故障配置不写模型、审计或失效缓存：%j', async (changes) => {
    const data = input(changes)
    const before = (await audits()).length
    expect(await call(saveAdminModel, data)).toMatchObject({ ok: false })
    expect(await db.select().from(aiModel).where(eq(aiModel.key, data.key))).toEqual([])
    expect((await audits()).length).toBe(before)
    expect(cacheValues.get(MODEL_CACHE_KEY)).toBe('unchanged')
  })

  it('合法保存、更新、复制和启用保留事务审计、schema摘要与缓存失效', async () => {
    const id = await create()
    expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
    const before = await row(id)
    const updatedSchema = {
      'x-acceptance-fault': { mode: 'chat-mid-stream' },
      'x-text': { maxOutputTokens: 1024 },
    }
    const updated = input({
      id,
      key: before?.key,
      paramsSchema: JSON.stringify(updatedSchema),
    })
    cacheValues.set(MODEL_CACHE_KEY, 'cached')
    expect(await call(saveAdminModel, updated)).toEqual({ ok: true, id })
    const persistedSchema = (await row(id))?.paramsSchema
    expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
    cacheValues.set(MODEL_CACHE_KEY, 'cached')
    const copied = await call(copyAdminModel, {
      id,
      key: `${before?.key}-copy`,
      paramsSchema: JSON.stringify(updatedSchema),
    })
    expect(copied.ok).toBe(true)
    if (!copied.ok) throw new Error('Copy failed')
    modelIds.push(copied.id)
    expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
    expect(await row(copied.id)).toMatchObject({ enabled: false, paramsSchema: updatedSchema })
    cacheValues.set(MODEL_CACHE_KEY, 'cached')
    expect(await call(setAdminModelEnabled, { id: copied.id, enabled: true })).toEqual({
      ok: true,
      id: copied.id,
    })
    expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
    const savedAudits = (await audits()).filter((entry) =>
      [id, copied.id].includes(entry.targetId ?? ''),
    )
    expect(savedAudits).toEqual([
      expect.objectContaining({
        action: 'ai.model_created',
        actorUserId: adminId,
        ip: context.ip,
        meta: expect.objectContaining({
          paramsSchema: { before: null, after: await hash(faultSchema) },
        }),
      }),
      expect.objectContaining({
        action: 'ai.model_updated',
        meta: expect.objectContaining({
          paramsSchema: {
            before: await hash(before?.paramsSchema),
            after: await hash(persistedSchema),
          },
        }),
      }),
      expect.objectContaining({
        action: 'ai.model_copied',
        meta: expect.objectContaining({
          sourceId: id,
          paramsSchema: { before: await hash(persistedSchema), after: await hash(persistedSchema) },
        }),
      }),
      expect.objectContaining({ action: 'ai.model_enabled', targetId: copied.id }),
    ])
    expect(JSON.stringify(savedAudits)).not.toContain('x-acceptance-fault')
  })

  it('复制验证来源与新key/schema，不能删除故障前缀或扩展降级成普通模型', async () => {
    const id = await create()
    const before = (await audits()).length
    for (const target of [
      { key: `normal-${runId}`, paramsSchema: JSON.stringify(faultSchema) },
      { key: `acceptance-fault-${runId}-missing`, paramsSchema: '{}' },
      { key: `normal-${runId}`, paramsSchema: '{}' },
    ]) {
      cacheValues.set(MODEL_CACHE_KEY, 'unchanged')
      expect(await call(copyAdminModel, { id, ...target })).toMatchObject({ ok: false })
      expect(await db.select().from(aiModel).where(eq(aiModel.key, target.key))).toEqual([])
      expect(cacheValues.get(MODEL_CACHE_KEY)).toBe('unchanged')
    }
    await db.update(aiModel).set({ paramsSchema: {} }).where(eq(aiModel.id, id))
    expect(
      await call(copyAdminModel, { id, key: `normal-${runId}`, paramsSchema: '{}' }),
    ).toMatchObject({ ok: false, error: 'ACCEPTANCE_FAULT_INVALID' })
    expect((await audits()).length).toBe(before)
  })

  it.each([undefined, 'disabled'])(
    '闸门%s拒绝保存、复制与启用，但允许停用遗留模型',
    async (gate) => {
      const id = await create({ enabled: true })
      runtime.env = { SENTRY_ENVIRONMENT: 'staging', ...(gate ? { AI_FAULT_INJECTION: gate } : {}) }
      const data = input()
      const before = (await audits()).length
      cacheValues.set(MODEL_CACHE_KEY, 'unchanged')
      for (const [action, payload] of [
        [saveAdminModel, data],
        [copyAdminModel, { id, key: `${data.key}-copy`, paramsSchema: data.paramsSchema }],
        [setAdminModelEnabled, { id, enabled: true }],
      ]) {
        expect(await call(action, payload)).toMatchObject({
          ok: false,
          error: 'AI_FAULT_INJECTION_DISABLED',
        })
      }
      expect(await db.select().from(aiModel).where(eq(aiModel.key, data.key))).toEqual([])
      expect((await audits()).length).toBe(before)
      expect(cacheValues.get(MODEL_CACHE_KEY)).toBe('unchanged')
      // 即使历史元数据已损坏，也必须保留停用清理能力。
      await db.update(aiModel).set({ paramsSchema: {} }).where(eq(aiModel.id, id))
      expect(await call(setAdminModelEnabled, { id, enabled: false })).toEqual({ ok: true, id })
      expect(await row(id)).toMatchObject({ enabled: false })
      expect((await audits()).slice(-1)).toEqual([
        expect.objectContaining({ action: 'ai.model_disabled', targetId: id }),
      ])
      expect(cacheValues.has(MODEL_CACHE_KEY)).toBe(false)
    },
  )

  it('启用前核验数据库完整配置，非法元数据保持停用且不留审计', async () => {
    const id = await create()
    const saved = await row(id)
    const before = (await audits()).length
    cacheValues.set(MODEL_CACHE_KEY, 'unchanged')
    expect(
      await call(saveAdminModel, input({ id, key: saved?.key, paramsSchema: '{}' })),
    ).toMatchObject({ ok: false, error: 'ACCEPTANCE_FAULT_INVALID' })
    expect(await row(id)).toEqual(saved)
    await db.update(aiModel).set({ providerModelId: 'different-model' }).where(eq(aiModel.id, id))
    expect(await call(setAdminModelEnabled, { id, enabled: true })).toMatchObject({
      ok: false,
      error: 'ACCEPTANCE_FAULT_INVALID',
    })
    expect(await row(id)).toMatchObject({ enabled: false })
    expect((await audits()).length).toBe(before)
    expect(cacheValues.get(MODEL_CACHE_KEY)).toBe('unchanged')
  })

  it('关闭故障开关时普通模型仍可保存、复制与启用', async () => {
    runtime.env = {}
    const id = await create({ key: `normal-${runId}-${newId().slice(-8)}`, paramsSchema: '{}' })
    const source = await row(id)
    const copied = await call(copyAdminModel, {
      id,
      key: `${source?.key}-copy`,
      paramsSchema: '{}',
    })
    expect(copied.ok).toBe(true)
    if (!copied.ok) throw new Error('Normal copy failed')
    modelIds.push(copied.id)
    expect(await call(setAdminModelEnabled, { id: copied.id, enabled: true })).toEqual({
      ok: true,
      id: copied.id,
    })
    expect(await row(copied.id)).toMatchObject({ enabled: true })
    // 旧普通媒体模型的启用不新增模板服务商限制；故障校验不能改变这条既有行为。
    await db
      .update(aiModel)
      .set({ kind: 'image', provider: 'legacy-media', paramsSchema: null })
      .where(eq(aiModel.id, id))
    expect(await call(setAdminModelEnabled, { id, enabled: true })).toEqual({ ok: true, id })
  })
})
