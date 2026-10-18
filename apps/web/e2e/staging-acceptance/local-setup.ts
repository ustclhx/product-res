import { chromium } from '@playwright/test'
import { grant } from '@product-res/credits'
import { createDb } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { loadEnv } from 'vite'
import { fixtureDb, simulateClientIp } from '../fixtures.ts'
import { stubTurnstile } from '../turnstile.ts'
import { ACCEPTANCE_MODELS } from './models.ts'

export default async function setup() {
  const browser = await chromium.launch()
  const sql = fixtureDb()
  const worktree = loadEnv('worktree', new URL('../../../../', import.meta.url).pathname, '')
  const db = createDb({ connectionString: worktree.DATABASE_URL ?? '' })
  try {
    for (const role of ['ADMIN', 'USER']) {
      const email = process.env[`STAGING_${role}_EMAIL`] ?? ''
      const password = process.env[`STAGING_${role}_PASSWORD`] ?? ''
      const [existing] = await sql`select id from "user" where email=${email}`
      if (!existing) {
        const page = await browser.newPage({ baseURL: process.env.STAGING_URL ?? '' })
        await simulateClientIp(page)
        await stubTurnstile(page)
        await page.goto('/register')
        const form = page.getByRole('form', { name: 'Create an account' })
        await form.getByLabel('Name', { exact: true }).fill('Acceptance local fixture')
        await form.getByLabel('Email', { exact: true }).fill(email)
        await form.getByLabel('Password', { exact: true }).fill(password)
        await form.getByRole('button', { name: 'Create account' }).click()
        await page.waitForURL(/\/app\/u-[a-z0-9]+\/?$/)
        await page.close()
      }
      if (role === 'ADMIN') await sql`update "user" set role='admin' where email=${email}`
      else {
        const [workspace] =
          await sql`select m.organization_id as id from member m join "user" u on u.id=m.user_id where u.email=${email} and m.role='owner' limit 1`
        if (!workspace) throw new Error('Missing local user workspace')
        // 只给本地验收空间授权，不调用支付 Provider，也不修改共享免费套餐。
        const key = `acceptance-local:${process.env.STAGING_ACCEPTANCE_RUN_ID}`
        await sql`insert into plan(id,key,name,type,credits,features,sort,active)
          values(${newId()},${key},'Local acceptance','subscription',0,
            ${sql.json({ ...DEFAULT_FREE_FEATURES, models: ACCEPTANCE_MODELS.map((model) => model.key) })},1000,false)
          on conflict(key) do nothing`
        const [plan] = await sql`select id from plan where key=${key}`
        if (!plan) throw new Error('Missing local entitlement plan')
        await sql`insert into plan_price(id,plan_id,provider,provider_price_id,interval,amount,currency,active)
          values(${newId()},${plan.id},'stripe',${key},'month',0,'usd',false)
          on conflict(provider,provider_price_id) do nothing`
        const [price] =
          await sql`select id from plan_price where provider='stripe' and provider_price_id=${key}`
        if (!price) throw new Error('Missing local entitlement price')
        await sql`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,
          provider_subscription_id,status,current_period_start,current_period_end,
          cancel_at_period_end,canceled_at,last_event_at)
          values(${newId()},${workspace.id},${plan.id},${price.id},'stripe',${key},
            'canceled',now(),now()+interval '1 day',true,now(),now())
          on conflict(provider,provider_subscription_id) do nothing`
        await grant(db, {
          workspaceId: String(workspace.id),
          source: 'promo',
          sourceRef: `acceptance-local:${process.env.STAGING_ACCEPTANCE_RUN_ID}`,
          amount: 100,
        })
      }
    }
    // 媒体后台当前缺 schema 字段；仅本地种子用于验证其后的业务流，不替代 staging 模型 UI 验收。
    for (const model of ACCEPTANCE_MODELS.filter((item) => item.kind !== 'text')) {
      await sql`insert into ai_model(id,key,kind,provider,provider_model_id,pricing,min_plan_features,params_schema,enabled,sort)
        values(${newId()},${model.key},${model.kind},${model.provider},${model.providerModelId},${sql.json(model.pricing)},'[]'::jsonb,${sql.json(model.paramsSchema)},true,${model.sort}) on conflict(key) do nothing`
    }
  } finally {
    await db.$client.end()
    await sql.end()
    await browser.close()
  }
}
