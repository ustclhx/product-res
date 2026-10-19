import { createHash, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import templateConfig from '../../../template.config.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test.skip(!templateConfig.ai.image, '本用例验证图片生成表单，模板配置关闭了 AI 图片')

// 后台写入、认证、权益与提交页 loader 均为真实本地链路；只 mock 任务 API，避免调用模型。
test('saved media parameter schemas drive submit fields, defaults and validation', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const sql = fixtureDb()
  const email = `admin-schema-${randomUUID()}@example.com`
  const key = `e2e-schema-${randomUUID().slice(0, 8)}`
  const planId = newId()
  const priceId = newId()
  const subscriptionId = newId()
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
    const [actor] = await sql`select u.id as user_id, o.id as workspace_id from "user" u
      join member m on m.user_id=u.id join organization o on o.id=m.organization_id
      where u.email=${email} and o.slug=${slug}`
    if (!actor) throw new Error('Missing admin workspace fixture')
    await sql`update "user" set role='admin' where id=${actor.user_id}`
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${key},'E2E schema','subscription',0,
        ${sql.json({ ...DEFAULT_FREE_FEATURES, models: [key] })},1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values (${subscriptionId},${actor.workspace_id},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`

    // 延迟客户端脚本，复现 SSR 表单可见但 React 尚未接管的窗口。
    let allowScripts = () => {}
    const scriptsReady = new Promise<void>((resolve) => {
      allowScripts = resolve
    })
    const gateScripts = async (route: import('@playwright/test').Route) => {
      if (route.request().resourceType() === 'script') await scriptsReady
      await route.continue()
    }
    await page.route('**/*', gateScripts)
    try {
      await page.goto('/admin/models', { waitUntil: 'commit' })
      // 新建表单默认收起；React 接管前展开按钮保持禁用，SSR 阶段的点击不会丢失
      await expect(page.getByRole('button', { name: 'New model', exact: true })).toBeDisabled()
      await expect(page.getByRole('article', { name: 'New model' })).toHaveCount(0)
    } finally {
      allowScripts()
      await page.unroute('**/*', gateScripts)
    }
    await page.getByRole('button', { name: 'New model', exact: true }).click()
    const form = page.getByRole('article', { name: 'New model' })
    await expect(form.getByRole('button', { name: 'Create model' })).toBeEnabled()
    await expect
      .poll(async () => {
        await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('video')
        return form
          .getByRole('combobox', { name: 'Provider', exact: true })
          .locator('option[value="fal"]')
          .count()
      })
      .toBe(1)
    await form.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('fal')
    await form
      .getByLabel('Insert reference template', { exact: true })
      .selectOption('fal-wan-turbo')
    const wanSchema = JSON.parse(
      await form.getByLabel('Parameters schema (JSON)', { exact: true }).inputValue(),
    )
    expect(wanSchema.properties.resolution).toMatchObject({
      title: 'Resolution',
      enum: ['480p', '580p', '720p'],
      default: '720p',
    })
    expect(wanSchema.properties).not.toHaveProperty('duration')
    await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('image')
    await form.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('workers-ai')
    await form.getByLabel('Key', { exact: true }).fill(key)
    await form.getByLabel('Provider model ID').fill('@cf/black-forest-labs/flux-1-schnell')
    await form.getByLabel('Plan tags (comma separated)').fill(key)
    await form.getByLabel('Sort', { exact: true }).fill('-1000')
    await form.getByLabel('Credits per call').fill('2')
    await form
      .getByLabel('Parameters schema (JSON)', { exact: true })
      .fill(JSON.stringify({ type: 'object', properties: { nested: { type: 'object' } } }))
    await form.getByRole('button', { name: 'Create model' }).click()
    await expect(form.getByRole('status')).toContainText('schema')
    expect(await sql`select id from ai_model where key=${key}`).toHaveLength(0)
    expect(
      await sql`select id from audit_log where actor_user_id=${actor.user_id} and target_type='ai_model'`,
    ).toHaveLength(0)

    await form
      .getByLabel('Insert reference template', { exact: true })
      .selectOption('workers-ai-flux-schnell')
    const initialSchema = JSON.parse(
      await form.getByLabel('Parameters schema (JSON)', { exact: true }).inputValue(),
    )
    expect(initialSchema.properties.steps).toMatchObject({ type: 'integer', default: 4 })
    await form.getByRole('button', { name: 'Create model' }).click()
    const card = page.getByRole('article', { name: `Model ${key}` })
    await expect(card).toBeVisible()
    const [created] = await sql`select id, params_schema from ai_model where key=${key}`
    expect(created?.params_schema).toEqual(initialSchema)

    const editedSchema = {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: 'Scene', minLength: 5, default: 'A forest' },
        steps: { type: 'integer', title: 'Sampling steps', minimum: 1, maximum: 8, default: 6 },
        image_size: {
          type: 'string',
          title: 'Canvas size',
          enum: ['square', 'portrait'],
          default: 'portrait',
        },
      },
      required: ['prompt', 'steps', 'image_size'],
      additionalProperties: false,
    }
    await card
      .getByLabel('Parameters schema (JSON)', { exact: true })
      .fill(JSON.stringify(editedSchema))
    await card.getByRole('button', { name: 'Save changes' }).click()
    await expect(card.getByRole('status')).toHaveText('Saved.')
    const [saved] = await sql`select params_schema from ai_model where key=${key}`
    expect(saved?.params_schema).toEqual(editedSchema)
    const audits =
      await sql`select action,meta from audit_log where target_type='ai_model' and target_id=${String(created?.id)} order by id`
    const hash = (schema: unknown) =>
      createHash('sha256').update(JSON.stringify(schema)).digest('hex')
    expect(audits.map((audit) => audit.action)).toEqual(['ai.model_created', 'ai.model_updated'])
    expect(audits[0]?.meta.paramsSchema).toEqual({
      before: null,
      after: hash(created?.params_schema),
    })
    expect(audits[1]?.meta.paramsSchema).toEqual({
      before: hash(created?.params_schema),
      after: hash(saved?.params_schema),
    })
    expect(JSON.stringify(audits)).not.toContain('A forest')

    await page.goto(`/app/${slug}/media/new`)
    // 注册表可能缓存旧列表；等待真实 loader 读到由后台保存的模型。
    await expect
      .poll(
        async () => {
          await page.reload()
          return page.getByLabel('Model').locator(`option[value="${key}"]`).count()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe(1)
    await page.getByLabel('Model').selectOption(key)
    await expect(page.getByLabel('Scene')).toHaveValue('A forest')
    await expect(page.getByLabel('Sampling steps')).toHaveValue('6')
    await expect(page.getByLabel('Canvas size')).toHaveValue('1')
    await expect(page.getByLabel('Canvas size').getByRole('option')).toHaveText([
      'Choose an option',
      'square',
      'portrait',
    ])
    await expect(page.getByTestId('media-credit-estimate')).toHaveText('Estimated cost: 2 credits')
    const submitted: unknown[] = []
    await page.route('**/api/ai/tasks', async (route) => {
      submitted.push(route.request().postDataJSON())
      await route.fulfill({ status: 503, json: { error: 'OFFLINE_TEST' } })
    })
    await page.getByLabel('Scene').fill('tiny')
    await page.getByLabel('Sampling steps').fill('9')
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect(page.getByLabel('Scene')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Sampling steps')).toHaveAttribute('aria-invalid', 'true')
    expect(submitted).toEqual([])
    await page.getByLabel('Scene').fill('A forest')
    await page.getByLabel('Sampling steps').fill('6')
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => submitted.length).toBe(1)
    expect(submitted).toEqual([
      {
        workspaceId: actor.workspace_id,
        modelKey: key,
        params: { prompt: 'A forest', steps: 6, image_size: 'portrait' },
      },
    ])
    expect(await sql`select id from ai_task where model_key=${key}`).toHaveLength(0)
  } finally {
    await sql`delete from ai_model where key=${key}`
    await sql`delete from subscription where id=${subscriptionId}`
    await sql`delete from plan_price where id=${priceId}`
    await sql`delete from plan where id=${planId}`
    await sql.end()
  }
})
