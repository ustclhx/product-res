import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import { removeModel, seedChatModel, slugOf } from './chat-fixtures.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 嵌入式 SubjectChat（openspec add-ai-chat-components tasks 5.2）：390px 下打开底部抽屉发送，生成中关闭，
// 再打开看到已完成的回复与草稿；桌面 inline 卡片与 panel 面板。浅色与深色截图与 chat-components/Embedded、
// EmbeddedMobile 副本对照。用 playwright.subject-chat.config.ts 运行（e2e/subject-chat/vite.ts 登记测试对象类型）。
// 选择器只用结构与 data 属性，不依赖界面语言。

const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-ai-chat-components',
)

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
})

/** 替换页面的 fetch：对话请求先发出一段正文并保持打开，`window.__finishReply()` 时补完并结束 */
async function fakeModel(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch
    const pending: (() => void)[] = []
    Object.assign(window, {
      __finishReply: () => {
        for (const finish of pending.splice(0)) finish()
      },
    })
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/api/ai/chat')) return original(input, init)
      const encoder = new TextEncoder()
      const line = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
      const body = JSON.parse(String(init?.body)) as { conversationId: string }
      const messageId = crypto.randomUUID()
      const stream = new ReadableStream({
        start(controller) {
          const metadata = { conversationId: body.conversationId, messageId }
          controller.enqueue(line({ type: 'start', messageId, messageMetadata: metadata }))
          controller.enqueue(line({ type: 'start-step' }))
          controller.enqueue(line({ type: 'text-start', id: 't1' }))
          controller.enqueue(
            line({ type: 'text-delta', id: 't1', delta: 'Long requests matter more: ' }),
          )
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          )
          pending.push(() => {
            controller.enqueue(
              line({
                type: 'text-delta',
                id: 't1',
                delta: 'they raise every request, while the backup model only runs at peak.',
              }),
            )
            controller.enqueue(line({ type: 'text-end', id: 't1' }))
            controller.enqueue(line({ type: 'finish-step' }))
            controller.enqueue(line({ type: 'finish' }))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          })
        },
      })
      return Promise.resolve(
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        }),
      )
    }
  })
}

async function shoot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), animations: 'disabled' })
}

/** 打开悬浮按钮对应的面板 / 抽屉；水合前的点击没有效果，直到打开为止重试 */
async function openShell(page: Page, shell: Locator) {
  await expect(async () => {
    if (!(await shell.isVisible())) await page.locator('[data-embedded-chat-trigger]').click()
    await expect(shell).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
}

async function noHorizontalScroll(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
}

/** 模型列表经 KV 缓存（TTL 60 秒）：刷新直到嵌入式对话拿到新写入的测试模型（预计消耗为 2 积分） */
async function openWithModel(page: Page, url: string, open: () => Promise<void>) {
  await expect(async () => {
    await page.goto(url)
    await open()
    await expect(page.getByTestId('credit-estimate')).toContainText('2', { timeout: 3_000 })
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] })
}

test('390px drawer keeps the reply and draft after closing mid-generation (5.2)', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await register(page, `subject-chat-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  try {
    await fakeModel(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    const sheet = page.locator('[data-embedded-chat="sheet"]')
    await openWithModel(page, `/app/${slug}/chat/context`, () => openShell(page, sheet))
    await noHorizontalScroll(page, 390)
    await shoot(page, 'subject-chat-390-not-started-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'subject-chat-390-not-started-dark')
    await page.emulateMedia({ colorScheme: 'light' })

    // 发送：第一次发送新建对象对话，回复开始生成
    const input = sheet.locator('textarea')
    await input.fill('Which of the two causes matters more?')
    await input.press('Enter')
    const reply = sheet.locator('li[data-role="assistant"]')
    await expect(reply).toContainText('Long requests matter more')
    await expect(sheet.locator('[data-action="stop"]')).toBeVisible()
    await noHorizontalScroll(page, 390)

    // 生成中写草稿并关闭抽屉；关闭期间回复完成
    await input.fill('How do we cap long requests?')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await page.evaluate(() => (window as unknown as { __finishReply(): void }).__finishReply())

    await openShell(page, sheet)
    await expect(reply).toContainText('only runs at peak.')
    await expect(sheet.locator('textarea')).toHaveValue('How do we cap long requests?')
    await expect(sheet.locator('[data-action="send"]')).toBeVisible()
    await noHorizontalScroll(page, 390)
    await shoot(page, 'subject-chat-390-in-progress-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'subject-chat-390-in-progress-dark')
  } finally {
    await removeModel(model.modelId)
  }
})

test('desktop inline card and side panel (5.2 screenshots)', async ({ page }) => {
  test.setTimeout(180_000)
  await register(page, `subject-chat-desk-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  try {
    await fakeModel(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    const card = page.locator('[data-embedded-chat="inline"]')
    await openWithModel(page, `/app/${slug}/chat/context`, async () => {
      await expect(card).toBeVisible()
    })
    await shoot(page, 'subject-chat-inline-not-started-light')
    const input = card.locator('textarea')
    await input.fill('Which of the two causes matters more?')
    await input.press('Enter')
    await expect(card.locator('li[data-role="assistant"]')).toContainText('Long requests')
    await page.evaluate(() => (window as unknown as { __finishReply(): void }).__finishReply())
    await expect(card.locator('[data-action="send"]')).toBeVisible()
    await shoot(page, 'subject-chat-inline-in-progress-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'subject-chat-inline-in-progress-dark')
    await page.emulateMedia({ colorScheme: 'light' })

    // panel：悬浮按钮打开右侧面板（对话流在页面内模拟、没有写库，这里重新发送一次）
    const panel = page.locator('[data-embedded-chat="panel"]')
    await page.goto(`/app/${slug}/chat/context?token=panel`)
    await openShell(page, panel)
    await expect(panel.getByTestId('credit-estimate')).toContainText('2')
    await panel.locator('textarea').fill('Which of the two causes matters more?')
    await panel.locator('textarea').press('Enter')
    await expect(panel.locator('li[data-role="assistant"]')).toContainText('Long requests')
    await page.evaluate(() => (window as unknown as { __finishReply(): void }).__finishReply())
    await expect(panel.locator('li[data-role="assistant"]')).toContainText('only runs at peak.')
    await shoot(page, 'subject-chat-panel-in-progress-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'subject-chat-panel-in-progress-dark')
  } finally {
    await removeModel(model.modelId)
  }
})

test('inline chat with history never scrolls the host page (mount and history switch)', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const email = `subject-chat-scroll-${randomUUID()}@example.com`
  await register(page, email)
  const slug = slugOf(page)
  const sql = fixtureDb()
  const older = newId()
  const latest = newId()
  try {
    const [row] = await sql`select o.id as workspace_id, u.id as user_id
      from organization o join "user" u on u.email = ${email} where o.slug = ${slug}`
    if (!row) throw new Error('Workspace fixture is missing')
    for (const [id, title, age] of [
      [older, 'Older chat', '2 hours'],
      [latest, 'Latest chat', '1 hour'],
    ] as const) {
      await sql`insert into ai_conversation (id, workspace_id, user_id, title, model_key, subject_type, subject_id, created_at, updated_at)
        values (${id}, ${row.workspace_id}, ${row.user_id}, ${title}, '', 'e2e-note', 'report-1',
          now() - ${age}::interval, now() - ${age}::interval)`
      const messages: [string, string, string][] = Array.from({ length: 6 }, (_, i) => [
        [newId(), 'user', `${title} question ${i}`] as [string, string, string],
        [newId(), 'assistant', `${title} answer ${i}: ${'detail '.repeat(30)}`] as [
          string,
          string,
          string,
        ],
      ]).flat()
      for (const [messageId, role, text] of messages)
        await sql`insert into ai_message (id, workspace_id, conversation_id, role, parts, status)
          values (${messageId}, ${row.workspace_id}, ${id}, ${role}, ${sql.json([{ type: 'text', text }])}, 'completed')`
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    const card = page.locator('[data-embedded-chat="inline"]')
    await page.goto(`/app/${slug}/chat/context`)
    await expect(card).toContainText('Latest chat answer 5')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    // 卡片自己的消息区停在最新消息
    const body = card.locator('li[data-role]').last()
    await expect(body).toBeInViewport()

    const history = card.locator('button[aria-haspopup="menu"]')
    await expect(async () => {
      await history.click()
      await expect(page.getByRole('menu')).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('menu').locator('[role^="menuitem"]', { hasText: 'Older chat' }).click()
    await expect(card).toContainText('Older chat answer 5')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  } finally {
    await sql`delete from ai_message where conversation_id in (${older}, ${latest})`
    await sql`delete from ai_conversation where id in (${older}, ${latest})`
    await sql.end()
  }
})
