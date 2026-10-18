import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_FREE_FEATURES } from '@product-res/entitlements'
import { newId } from '@product-res/shared'
import type { MediaTask } from '../src/features/ai-media/tasks-client.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

const RESULT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPZkAAAAASUVORK5CYII=',
  'base64',
)

// 真实本地认证、空间与提交页 loader；任务 API 用浏览器 mock，不能替代 Workflow 集成验收。
test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
})

async function workspaceFixture(page: Page) {
  const email = `media-${randomUUID()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const sql = fixtureDb()
  try {
    const [row] = await sql`select o.id as "workspaceId", u.id as "userId"
      from organization o join member m on m.organization_id = o.id
      join "user" u on u.id = m.user_id where o.slug = ${slug} and u.email = ${email}`
    if (!row) throw new Error('Registered workspace fixture missing')
    return { slug, workspaceId: String(row.workspaceId), userId: String(row.userId) }
  } finally {
    await sql.end()
  }
}

function taskFixture(
  workspace: { workspaceId: string; userId: string },
  values: Partial<MediaTask> = {},
): MediaTask {
  const now = new Date().toISOString()
  return {
    ...workspace,
    id: newId(),
    kind: 'image',
    modelKey: 'e2e-media',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    deadlineAt: new Date(Date.now() + 7_200_000).toISOString(),
    creditsCharged: 0,
    errorCode: null,
    errorMessage: null,
    params: { prompt: 'A forest' },
    files: [],
    canCancel: true,
    ...values,
  }
}

async function seedMediaModel(workspaceId: string) {
  const sql = fixtureDb()
  const key = `e2e-media-${randomUUID().slice(0, 8)}`
  const modelId = newId()
  const planId = newId()
  const priceId = newId()
  const subscriptionId = newId()
  try {
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${key},'E2E media','subscription',0,
        ${sql.json({ ...DEFAULT_FREE_FEATURES, models: [key] })},1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values (${subscriptionId},${workspaceId},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`
    await sql`insert into ai_model (id,key,kind,provider,provider_model_id,pricing,
      min_plan_features,params_schema,sort)
      values (${modelId},${key},'image','workers-ai','@cf/black-forest-labs/flux-1-schnell',
        ${sql.json({ mode: 'per_call', credits: 2 })},${sql.json([key])},
        ${sql.json({ type: 'object', properties: { prompt: { type: 'string', title: 'Prompt', minLength: 1 } }, required: ['prompt'] })},-1000)`
  } finally {
    await sql.end()
  }
  return {
    key,
    async cleanup() {
      const sql = fixtureDb()
      try {
        await sql`delete from ai_model where id = ${modelId}`
        await sql`delete from subscription where id = ${subscriptionId}`
        await sql`delete from plan_price where id = ${priceId}`
        await sql`delete from plan where id = ${planId}`
      } finally {
        await sql.end()
      }
    },
  }
}

test('submits, follows progress, previews and downloads a result, and manages its share', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const workspace = await workspaceFixture(page)
  const model = await seedMediaModel(workspace.workspaceId)
  const fileId = newId()
  const downloadUrl = `/api/files/${fileId}?workspaceId=${workspace.workspaceId}`
  const sql = fixtureDb()
  // 独立本机 origin 模拟 R2：跨域重定向必须靠 attachment 响应触发下载。
  const resultServer = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Disposition': 'attachment; filename="result.png"',
    })
    response.end(RESULT_PNG)
  })
  await new Promise<void>((resolve, reject) => {
    resultServer.once('error', reject)
    resultServer.listen(0, '127.0.0.1', resolve)
  })
  const resultOrigin = `http://127.0.0.1:${(resultServer.address() as AddressInfo).port}`
  try {
    // 分享使用真实 Server Function 与属于本测试的 ready 文件，不需要 R2 或服务商凭据。
    await sql`insert into file (id,workspace_id,user_id,purpose,status,r2_key,mime,size)
      values (${fileId},${workspace.workspaceId},${workspace.userId},'ai_output','ready',
        ${`ws/${workspace.workspaceId}/${fileId}`},'image/png',68)`
    await page.goto(`/app/${workspace.slug}/media/new`)
    // 模型注册表有 60 秒 KV 缓存，等待真实 loader 读到本测试模型。
    await expect
      .poll(
        async () => {
          await page.reload()
          return page.getByLabel('Model').locator(`option[value="${model.key}"]`).count()
        },
        { timeout: 90_000, intervals: [2_000, 5_000] },
      )
      .toBe(1)
    await page.getByLabel('Model').selectOption(model.key)
    await page.getByLabel('Prompt').fill('A forest')
    await expect(page.getByTestId('media-credit-estimate')).toHaveText('Estimated cost: 2 credits')

    const task = taskFixture(workspace, { modelKey: model.key })
    const submitted: unknown[] = []
    await page.route('**/api/ai/tasks', async (route) => {
      expect(route.request().method()).toBe('POST')
      submitted.push(route.request().postDataJSON())
      await route.fulfill({ json: { taskId: task.id } })
    })
    let reads = 0
    let nextStatus: MediaTask['status'] = 'queued'
    await page.route(`**/api/ai/tasks/${task.id}?*`, async (route) => {
      expect(new URL(route.request().url()).searchParams.get('workspaceId')).toBe(
        workspace.workspaceId,
      )
      reads++
      const status = nextStatus
      await route.fulfill({
        json: {
          task: {
            ...task,
            status,
            canCancel: status !== 'succeeded',
            creditsCharged: status === 'succeeded' ? 2 : 0,
            files:
              status === 'succeeded'
                ? [
                    {
                      id: fileId,
                      mime: 'image/png',
                      size: 68,
                      width: 1,
                      height: 1,
                      duration: null,
                      downloadUrl,
                    },
                  ]
                : [],
          },
        },
      })
    })
    await page.route(`**/api/files/${fileId}?*`, (route) =>
      new URL(route.request().url()).searchParams.get('download') === '1'
        ? route.fulfill({ status: 302, headers: { location: `${resultOrigin}/result.png` } })
        : route.fulfill({ contentType: 'image/png', body: RESULT_PNG }),
    )
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/app/${workspace.slug}/tasks/${task.id}$`))
    expect(submitted).toEqual([
      { workspaceId: workspace.workspaceId, modelKey: model.key, params: { prompt: 'A forest' } },
    ])
    const status = page.getByTestId('media-task-status')
    await expect(status).toHaveText('Queued')
    nextStatus = 'running'
    await expect(status).toHaveText('Running', { timeout: 5_000 })
    nextStatus = 'succeeded'
    await expect(status).toHaveText('Completed', { timeout: 7_000 })
    const results = page.getByRole('region', { name: 'Results', exact: true })
    const preview = results.getByRole('img', { name: 'Generated result 1' })
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    await page.screenshot({
      path: test.info().outputPath('media-task-completed.png'),
      fullPage: true,
    })
    const download = page.waitForEvent('download')
    await expect(results.getByRole('link', { name: 'Download result' })).toHaveAttribute(
      'href',
      /[?&]download=1(?:&|$)/,
    )
    await results.getByRole('link', { name: 'Download result' }).click()
    const downloaded = await download
    expect(await downloaded.failure()).toBeNull()
    expect(downloaded.suggestedFilename()).toBe('result.png')
    const downloadedPath = await downloaded.path()
    if (!downloadedPath) throw new Error('Result download missing')
    expect(readFileSync(downloadedPath).equals(RESULT_PNG)).toBe(true)
    await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0)

    await results.getByRole('button', { name: 'Generate public share link' }).click()
    const share = results.getByLabel('Public share link', { exact: true })
    await expect(share).toHaveValue(/\/api\/files\/shared\/[0-9a-f-]{36}$/)
    const shareUrl = await share.inputValue()
    const [shared] = await sql`select public_token from file where id = ${fileId}`
    expect(new URL(shareUrl).pathname.endsWith(String(shared?.public_token))).toBe(true)
    await results.getByRole('button', { name: 'Revoke public share link' }).click()
    await expect(results.getByText('The public share link has been revoked.')).toBeVisible()
    await expect(share).toHaveCount(0)
    const [revoked] = await sql`select public_token from file where id = ${fileId}`
    expect(revoked?.public_token).toBeNull()
    expect((await page.request.get(shareUrl)).status()).toBe(404)

    // 超过轮询最长间隔仍无请求，证明终态停止自动读取。
    const terminalReads = reads
    await page.waitForTimeout(11_000)
    expect(reads).toBe(terminalReads)
  } finally {
    await new Promise<void>((resolve, reject) =>
      resultServer.close((error) => (error ? reject(error) : resolve())),
    )
    await sql`delete from file where id = ${fileId}`
    await sql.end()
    await model.cleanup()
  }
})

test('pages through task cursors and opens details', async ({ page }) => {
  const workspace = await workspaceFixture(page)
  const recent = taskFixture(workspace, { status: 'running' })
  const older = taskFixture(workspace, { status: 'succeeded', creditsCharged: 2, canCancel: false })
  const cursors: (string | null)[] = []
  await page.route('**/api/ai/tasks?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    expect(query.get('workspaceId')).toBe(workspace.workspaceId)
    cursors.push(query.get('cursor'))
    await route.fulfill({
      json:
        query.get('cursor') === recent.id
          ? { items: [older], nextCursor: null }
          : { items: [recent], nextCursor: recent.id },
    })
  })
  await page.route(`**/api/ai/tasks/${older.id}?*`, (route) =>
    route.fulfill({ json: { task: older } }),
  )
  await page.goto(`/app/${workspace.slug}/tasks`)
  const table = page.getByRole('table', { name: 'Media tasks' })
  await expect(table.getByRole('row').filter({ hasText: recent.id })).toContainText('Running')
  await page.screenshot({ path: test.info().outputPath('media-task-list.png'), fullPage: true })
  await expect(page.getByRole('button', { name: 'Newer tasks' })).toBeDisabled()
  cursors.length = 0
  await page.getByRole('button', { name: 'Older tasks' }).click()
  await expect(table.getByRole('row').filter({ hasText: older.id })).toContainText('Completed')
  await expect(page.getByRole('button', { name: 'Older tasks' })).toBeDisabled()
  await page.getByRole('button', { name: 'Newer tasks' }).click()
  await expect(table.getByRole('link', { name: recent.id })).toBeVisible()
  expect(cursors).toEqual([recent.id, null])
  await page.getByRole('button', { name: 'Older tasks' }).click()
  await table.getByRole('link', { name: older.id }).click()
  await expect(page).toHaveURL(new RegExp(`/app/${workspace.slug}/tasks/${older.id}$`))
  await expect(page.getByTestId('media-task-status')).toHaveText('Completed')
})

test('restores pending external cancellation after reload and explains uncertain failures', async ({
  page,
}) => {
  const workspace = await workspaceFixture(page)
  let task = taskFixture(workspace)
  await page.route(`**/api/ai/tasks/${task.id}?*`, (route) => route.fulfill({ json: { task } }))
  const cancelBodies: unknown[] = []
  await page.route(`**/api/ai/tasks/${task.id}/cancel`, async (route) => {
    cancelBodies.push(route.request().postDataJSON())
    task = {
      ...task,
      status: 'canceled',
      canCancel: false,
      errorCode: cancelBodies.length === 1 ? 'MEDIA_CANCEL_PENDING' : null,
    }
    await route.fulfill({
      json: { taskId: task.id, status: 'canceled', cancellationPending: cancelBodies.length === 1 },
    })
  })
  await page.goto(`/app/${workspace.slug}/tasks/${task.id}`)
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click()
  await expect(page.getByTestId('media-task-status')).toHaveText('Canceled')
  const pending = page.getByText(
    'The task is canceled and credits have been returned. External cancellation is still pending; you can retry it.',
  )
  await expect(pending).toBeVisible()
  await page.reload()
  await expect(pending).toBeVisible()
  await page.getByRole('button', { name: 'Retry external cancellation' }).click()
  await expect(pending).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry external cancellation' })).toHaveCount(0)
  expect(cancelBodies).toEqual([
    { workspaceId: workspace.workspaceId },
    { workspaceId: workspace.workspaceId },
  ])

  const failed = taskFixture(workspace, {
    status: 'failed',
    canCancel: false,
    errorCode: 'MEDIA_SUBMISSION_UNCERTAIN',
    errorMessage: 'Submission response was lost.',
  })
  await page.route(`**/api/ai/tasks/${failed.id}?*`, (route) =>
    route.fulfill({ json: { task: failed } }),
  )
  await page.goto(`/app/${workspace.slug}/tasks/${failed.id}`)
  await expect(page.getByTestId('media-task-status')).toHaveText('Failed')
  await expect(page.getByRole('alert')).toContainText('Reserved credits have been returned.')
  await expect(page.getByRole('alert')).toContainText(
    'The provider does not support idempotent submissions',
  )
  await expect(page.getByRole('alert')).toContainText('Submission response was lost.')
  await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0)
})
