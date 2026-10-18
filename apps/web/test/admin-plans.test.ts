import { dbModelStore, requireAvailableModel } from '@product-res/ai'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { auditLog, plan } from '@product-res/db'
import { DEFAULT_FREE_FEATURES, getEntitlements } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdminAccessRevokedError, runAdminAction } from '../src/features/admin/action.ts'
import { requireAdmin } from '../src/features/admin/guard.ts'
import { listAdminPlans, updateAdminPlanModels } from '../src/features/billing/admin-plans.ts'
import { adminPlanModelsInput } from '../src/features/billing/admin-plans-input.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const adminId = newId()
const memberId = newId()
const workspaceId = newId()
const planId = newId()
const priceId = newId()
const modelIds = [newId(), newId()]
const modelKeys = modelIds.map((id) => `plan-test-${id}`)
const planKey = `plan-test-${planId}`
const features = {
  ...DEFAULT_FREE_FEATURES,
  models: [modelKeys[0]],
  maxSeats: 9,
  custom: { preserved: true },
}
const context = { db, admin: { id: adminId }, ip: '203.0.113.7' }
const update = (models: string[], actor = context) =>
  runAdminAction(actor, 'admin.plan.models.update', (scope) =>
    updateAdminPlanModels(scope, { id: planId, models }),
  )
const saved = async () => (await db.select().from(plan).where(eq(plan.id, planId)))[0]
const audits = () => db.select().from(auditLog).where(eq(auditLog.targetId, planId))

beforeAll(async () => {
  await db.$client`insert into "user"(id,name,email,role) values(${adminId},'Admin',${`${adminId}@plan-test.example`},'admin'),(${memberId},'Member',${`${memberId}@plan-test.example`},'user')`
  await db.$client`insert into organization(id,name,slug) values(${workspaceId},'Plan fixture',${workspaceId})`
  await db.$client`insert into plan(id,key,name,type,credits,features,active) values(${planId},${planKey},'Plan fixture','subscription',100,${JSON.stringify(features)}::jsonb,false)`
  await db.$client`insert into plan_price(id,plan_id,provider,provider_price_id,interval,amount,currency) values(${priceId},${planId},'stripe',${priceId},'month',1234,'usd')`
  await db.$client`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,current_period_end,last_event_at) values(${newId()},${workspaceId},${planId},${priceId},'stripe',${planId},'active',now()+interval '1 day',now())`
  for (let index = 0; index < modelIds.length; index++) {
    await db.$client`insert into ai_model(id,key,kind,provider,provider_model_id,pricing) values(${modelIds[index] as string},${modelKeys[index] as string},'text','openai','fixture','{"mode":"token","inputPer1k":1,"outputPer1k":1,"minCharge":1}'::jsonb)`
  }
})

afterAll(async () => {
  await migrator.$client`delete from audit_log where target_id=${planId}`
  await db.$client`delete from subscription where workspace_id=${workspaceId}`
  await db.$client`delete from plan_price where plan_id=${planId}`
  await db.$client`delete from plan where id=${planId}`
  await db.$client`delete from ai_model where id in ${db.$client(modelIds)}`
  await db.$client`delete from organization where id=${workspaceId}`
  await db.$client`delete from "user" where id in ${db.$client([adminId, memberId])}`
  await Promise.all([db.$client.end(), migrator.$client.end()])
})

describe('后台套餐模型权限', () => {
  it('下一请求允许新增模型并以403拒绝移除模型，审计和其他权益及价格保留', async () => {
    const registry = { store: dbModelStore(db) }
    const before = await getEntitlements(db, workspaceId)
    await expect(
      requireAvailableModel(registry, before, modelIds[0] as string),
    ).resolves.toMatchObject({ key: modelKeys[0] })
    await expect(
      requireAvailableModel(registry, before, modelIds[1] as string),
    ).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED', status: 403 })
    await update([` ${modelKeys[1]} `, modelKeys[1] as string])
    const after = await getEntitlements(db, workspaceId)
    await expect(
      requireAvailableModel(registry, after, modelIds[1] as string),
    ).resolves.toMatchObject({ key: modelKeys[1] })
    await expect(
      requireAvailableModel(registry, after, modelIds[0] as string),
    ).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED', status: 403 })
    expect((await saved())?.features).toEqual({ ...features, models: [modelKeys[1]] })
    const [price] = await db.$client`select amount,currency from plan_price where id=${priceId}`
    expect(price).toEqual({ amount: 1234, currency: 'usd' })
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorUserId: adminId,
        action: 'admin.plan.models.update',
        targetType: 'plan',
        ip: context.ip,
        meta: { key: planKey, models: { before: [modelKeys[0]], after: [modelKeys[1]] } },
      }),
    ])
  })

  it('只允许既有历史值、现有模型或通配符，历史值可明确移除、空数组撤销全部授权', async () => {
    const historical = 'retired-model'
    await db.$client`update plan set features=jsonb_set(features,'{models}',${JSON.stringify([historical])}::jsonb) where id=${planId}`
    await update([historical, '*'])
    expect((await saved())?.features.models).toEqual([historical, '*'])
    const count = (await audits()).length
    await expect(update([historical, 'unknown-new-model'])).rejects.toMatchObject({
      code: 'INVALID_PLAN_MODEL',
    })
    expect((await audits()).length).toBe(count)
    expect((await saved())?.features.models).toEqual([historical, '*'])
    await update([])
    expect((await saved())?.features.models).toEqual([])
    await expect(update([historical])).rejects.toMatchObject({ code: 'INVALID_PLAN_MODEL' })
    expect(adminPlanModelsInput.safeParse({ id: planId, models: [' '] }).success).toBe(false)
  })

  it('普通用户和撤权管理员不能写入，未认证会话无法通过后台守卫', async () => {
    const count = (await audits()).length
    await expect(update(['*'], { ...context, admin: { id: memberId } })).rejects.toBeInstanceOf(
      AdminAccessRevokedError,
    )
    await db.$client`update "user" set role='user' where id=${adminId}`
    await expect(update(['*'])).rejects.toBeInstanceOf(AdminAccessRevokedError)
    const auth = createAuth(
      {
        BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
        APP_URL: 'http://localhost:3000',
      },
      db,
      {
        config: defineTemplateConfig({
          app: { name: 'Test', url: 'http://localhost:3000', supportEmail: 'support@example.test' },
          auth: { oauth: [], turnstile: false },
        }),
        sendEmail: async () => {},
      },
    )
    await expect(requireAdmin({ auth, db, headers: new Headers() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
    expect((await saved())?.features.models).toEqual([])
    expect((await audits()).length).toBe(count)
    await db.$client`update "user" set role='admin' where id=${adminId}`
  })

  it('列表包含未启用套餐，分页与搜索保持一致，事务失败回滚权限与审计', async () => {
    const result = await listAdminPlans(db, { offset: 0, q: planKey })
    expect(result.rows).toEqual([
      expect.objectContaining({ id: planId, active: false, models: [] }),
    ])
    expect((await listAdminPlans(db, { offset: 1, q: planKey })).rows).toEqual([])
    const count = (await audits()).length
    await expect(
      runAdminAction(context, 'admin.plan.models.update', async (scope) => {
        await updateAdminPlanModels(scope, { id: planId, models: ['*'] })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect((await saved())?.features.models).toEqual([])
    expect((await audits()).length).toBe(count)
  })
})
