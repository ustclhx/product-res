import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { stripVTControlCharacters } from 'node:util'
import { expect, type Page } from '@playwright/test'
import type { Database } from '@product-res/db'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import { loadEnv } from 'vite'
import templateConfig from '../../../template.config.ts'

export const PASSWORD = 'correct-horse-battery'
// i18n 关闭时页面使用默认语言，表单标签按该语言的消息文件匹配
const uiLocale = templateConfig.i18n.enabled ? 'en' : templateConfig.i18n.defaultLocale
const authMessages = JSON.parse(
  readFileSync(new URL(`../messages/${uiLocale}/auth.json`, import.meta.url), 'utf8'),
) as Record<string, string>
export function authText(key: string) {
  const text = authMessages[key]
  if (!text) throw new Error(`Missing auth message ${key}`)
  return text
}
export const APP_URL = /\/app\/u-[a-z0-9]+\/?$/
const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url))
// Never fall back to a shared checkout database.
export function fixtureDb() {
  if (!env.DATABASE_URL || !new URL(env.DATABASE_URL).pathname.startsWith('/product_res_wt_'))
    throw new Error('E2E fixtures require an isolated worktree DATABASE_URL')
  const postgres = require('postgres') as (
    url: string,
    options: { max: number },
  ) => Database['$client']
  return postgres(env.DATABASE_URL, { max: 1 })
}
/** Paid-period fixture admits members without contacting a payment platform. */
export async function seedWorkspaceSeats(slug: string) {
  const sql = fixtureDb()
  try {
    const [workspace] = await sql`select id from organization where slug=${slug}`
    if (!workspace) throw new Error('Workspace fixture is missing')
    const planId = newId()
    const priceId = newId()
    const features = JSON.stringify({ ...DEFAULT_FREE_FEATURES, maxSeats: 5 })
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${`e2e-seats-${planId}`},'E2E seats','subscription',0,${features}::jsonb,1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    // A canceled subscription still carries its paid period; deletion needs no remote call.
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values (${newId()},${workspace.id},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`
  } finally {
    await sql.end()
  }
}

export async function register(page: Page, email: string, name = 'Workspace Owner') {
  await page.goto('/register')
  const form = page.getByRole('form', { name: authText('auth_create_an_account') })
  await form.getByLabel(authText('auth_name'), { exact: true }).fill(name)
  await form.getByLabel(authText('auth_email'), { exact: true }).fill(email)
  await form.getByLabel(authText('auth_password'), { exact: true }).fill(PASSWORD)
  await form.getByRole('button', { name: authText('auth_create_account') }).click()
  await expect(page).toHaveURL(APP_URL)
}
export async function login(page: Page, email: string, path = '/login') {
  await page.goto(path)
  const form = page.getByRole('form', { name: authText('auth_sign_in_with_password') })
  await form.getByLabel(authText('auth_email'), { exact: true }).fill(email)
  await form.getByLabel(authText('auth_password'), { exact: true }).fill(PASSWORD)
  await form.getByRole('button', { name: authText('auth_sign_in'), exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
}
/** Local workerd honors this header; separate simulated clients retain real 10/min limits. */
export async function simulateClientIp(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}`,
  })
}

export async function verifyInvitation(
  page: Page,
  email: string,
  id: string,
  workspaceName: string,
) {
  await expect(page.getByText(workspaceName, { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toHaveCount(0)
  const request = page.waitForRequest('**/api/auth/send-verification-email')
  await page.getByRole('button', { name: 'Send verification email' }).click()
  expect((await request).postDataJSON()).toEqual({
    email,
    callbackURL: `/accept-invitation?id=${id}`,
  })
  await expect(
    page.getByText('Verification email sent. Check your inbox and open the link.'),
  ).toBeVisible()
  await page.goto(await emailLink(email))
  await expect(page).toHaveURL(new RegExp(`/accept-invitation\\?id=${id}$`))
  await expect(
    page.getByText(`You are invited to ${workspaceName}`, { exact: false }),
  ).toBeVisible()
}

export async function loginOtp(page: Page, email: string, path = '/login') {
  await page.goto(path)
  await page.getByRole('button', { name: 'Sign in with email code' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByLabel('Verification code')).toBeVisible()
  await page.getByLabel('Verification code').fill(await emailCode(email))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
}
/**
 * Auth emails printed by the local-development logger. The dev server may colorize
 * `console.log` output (util.inspect colors, FORCE_COLOR), so ANSI sequences are stripped
 * before matching regardless of the environment.
 */
function authEmails() {
  const log = readFileSync(process.env.E2E_AUTH_LOG ?? '/tmp/p1-phase-e2e-auth.log', 'utf8')
  return stripVTControlCharacters(log).match(/\[dev\] auth email \{[\s\S]*?\n\}/g) ?? []
}

/** Consume only the existing local-development email logger, never forge a token. */
export async function emailLink(email: string, type = 'verify-email') {
  let link = ''
  await expect
    .poll(() => {
      const message = authEmails().findLast(
        (entry) => entry.includes(email) && entry.includes(type),
      )
      link = message?.match(/url: ['"]([^'"]+)['"]/)?.[1] ?? ''
      return link
    })
    .not.toBe('')
  return link
}

export async function emailCode(email: string) {
  let code = ''
  await expect
    .poll(() => {
      const message = authEmails().findLast(
        (entry) => entry.includes(email) && entry.includes('otp'),
      )
      code = message?.match(/otp: ['"](\d{6})['"]/)?.[1] ?? ''
      return code
    })
    .not.toBe('')
  return code
}
