import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('admin can save model selections, retain historical keys and explicitly remove them', async ({
  page,
}) => {
  const sql = fixtureDb()
  const email = `admin-plans-${randomUUID()}@example.com`
  const planId = randomUUID()
  const modelId = randomUUID()
  const key = `e2e-plans-${planId}`
  const modelKey = `e2e-model-${modelId}`
  const historical = 'e2e-retired-model'
  const features = { ...DEFAULT_FREE_FEATURES, models: [historical], custom: { preserved: true } }
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    await page.goto('/admin/billing/plans')
    await expect(page.getByRole('heading', { name: 'Plan model access' })).toHaveCount(0)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing account fixture')
    await sql`update "user" set role='admin' where id=${account.id}`
    await sql`insert into ai_model(id,key,kind,provider,provider_model_id,pricing,enabled) values(${modelId},${modelKey},'text','openai','fixture','{"mode":"token","inputPer1k":1,"outputPer1k":1,"minCharge":1}'::jsonb,false)`
    await sql`insert into plan(id,key,name,type,credits,features,active) values(${planId},${key},'Model access fixture','credit_pack',100,${sql.json(features)},false)`
    await page.goto(`/admin/billing/plans?q=${key}`)
    const editor = page.getByRole('article', { name: `Plan ${key}` })
    await expect(editor.getByRole('alert')).toContainText(historical)
    await expect(editor).toContainText('Credit pack: these selections do not grant model access.')
    await expect(editor.getByLabel(`${historical} (historical; model missing)`)).toBeChecked()
    await editor.getByLabel(`${modelKey} (disabled)`).check()
    await editor.getByRole('button', { name: 'Save model access' }).click()
    await expect(editor.getByRole('status')).toHaveText('Saved.')
    await expect
      .poll(async () => (await sql`select features from plan where id=${planId}`)[0]?.features)
      .toEqual({ ...features, models: [historical, modelKey] })
    await editor.getByLabel(`${historical} (historical; model missing)`).uncheck()
    await editor.getByLabel('All models (*)').check()
    await editor.getByRole('button', { name: 'Save model access' }).click()
    await expect
      .poll(async () => (await sql`select features from plan where id=${planId}`)[0]?.features)
      .toEqual({ ...features, models: [modelKey, '*'] })
    await expect(editor.getByRole('alert')).toHaveCount(0)
    await page.reload()
    await expect(editor.getByLabel('All models (*)')).toBeChecked()
    await expect(editor.getByLabel(`${modelKey} (disabled)`)).toBeChecked()
    const [audit] =
      await sql`select meta from audit_log where target_id=${planId} and action='admin.plan.models.update' order by created_at desc limit 1`
    expect(audit?.meta.models).toEqual({ before: [historical, modelKey], after: [modelKey, '*'] })
  } finally {
    await sql`delete from plan where id=${planId}`
    await sql`delete from ai_model where id=${modelId}`
    await sql.end()
  }
})
