import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { chromium } from '@playwright/test'
import { grant } from '@product-res/credits'
import { createDb } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { simulateClientIp } from '../fixtures.ts'
import { stubTurnstile } from '../turnstile.ts'
import { FAULT_MODELS } from './fault-definitions.ts'

export default async function setup() {
  if (process.env.STAGING_ACCEPTANCE_LOCAL !== '1') throw new Error('Local-only fault setup')
  const worktree = parseEnv(
    readFileSync(new URL('../../../../.env.worktree', import.meta.url), 'utf8'),
  )
  const url = new URL(worktree.DATABASE_URL ?? 'http://missing')
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/product_res_wt_[a-zA-Z0-9_-]+$/.test(url.pathname)
  )
    throw new Error('Fault setup requires an isolated loopback database')
  const db = createDb({ connectionString: url.toString() })
  const sql = db.$client
  const browser = await chromium.launch()
  try {
    const email = process.env.STAGING_ADMIN_EMAIL ?? ''
    const password = process.env.STAGING_ADMIN_PASSWORD ?? ''
    if (!email || !password) throw new Error('Missing local administrator credentials')
    const [existing] = await sql`select id from "user" where email=${email}`
    if (!existing) {
      const page = await browser.newPage({ baseURL: process.env.STAGING_URL ?? '' })
      await simulateClientIp(page)
      await stubTurnstile(page)
      await page.goto('/register')
      const form = page.getByRole('form', { name: 'Create an account' })
      await form.getByLabel('Name', { exact: true }).fill('Local fault acceptance')
      await form.getByLabel('Email', { exact: true }).fill(email)
      await form.getByLabel('Password', { exact: true }).fill(password)
      await form.getByRole('button', { name: 'Create account' }).click()
      await page.waitForURL(/\/app\/u-[a-z0-9]+\/?$/)
      await page.close()
    }
    await sql`update "user" set role='admin' where email=${email}`
    const [workspace] =
      await sql`select m.organization_id as id from member m join "user" u on u.id=m.user_id where u.email=${email} and m.role='owner' limit 1`
    if (!workspace) throw new Error('Missing local administrator workspace')
    const key = `fault-local:${process.env.STAGING_ACCEPTANCE_RUN_ID}`
    const features = { ...DEFAULT_FREE_FEATURES, models: FAULT_MODELS.map((model) => model.key) }
    await sql`insert into plan(id,key,name,type,credits,features,sort,active)
      values(${newId()},${key},'Local fault acceptance','subscription',0,${JSON.stringify(features)}::jsonb,1000,false)
      on conflict(key) do update set features=excluded.features`
    const [plan] = await sql`select id from plan where key=${key}`
    if (!plan) throw new Error('Missing local fault plan')
    await sql`insert into plan_price(id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values(${newId()},${plan.id},'stripe',${key},'month',0,'usd',false)
      on conflict(provider,provider_price_id) do nothing`
    const [price] =
      await sql`select id from plan_price where provider='stripe' and provider_price_id=${key}`
    if (!price) throw new Error('Missing local fault price')
    // 只给隔离库中的管理员空间授予有效期权益，不接触免费套餐与模型表。
    await sql`insert into subscription(id,workspace_id,plan_id,plan_price_id,provider,provider_subscription_id,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,last_event_at)
      values(${newId()},${workspace.id},${plan.id},${price.id},'stripe',${key},'canceled',now(),now()+interval '1 day',true,now(),now())
      on conflict(provider,provider_subscription_id) do update set current_period_end=now()+interval '1 day'`
    await grant(db, {
      workspaceId: String(workspace.id),
      source: 'promo',
      sourceRef: key,
      amount: 100,
    })
  } finally {
    await browser.close()
    await sql.end()
  }
}
