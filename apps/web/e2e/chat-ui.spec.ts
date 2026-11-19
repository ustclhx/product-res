import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@product-res/shared'
import {
  chooseSeededModel,
  newConversation,
  removeModel,
  seedChatModel,
  slugOf,
} from './chat-fixtures.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 对话页切换到 @product-res/ui/chat 组件（openspec add-ai-chat-components tasks 4.5）：Markdown 表格与代码块、
// 代码复制、停止后显示已停止、390px 无横向滚动，浅色与深色截图（与 chat-components/Main、Mobile 副本对照）。
// 本地没有真实模型：页面的 fetch 被替换为可控的 UI message 流；选择器只用结构与 data 属性，不依赖界面语言。

const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-ai-chat-components',
)

const LONG_LINE = `rows = [${Array.from({ length: 40 }, (_, i) => `"channel-${i}"`).join(', ')}]`
const CODE = [
  'def cac(spend: dict[str, float], new_users: dict[str, int]) -> dict[str, float]:',
  '    # 新客为 0 的渠道不计算，避免除零',
  '    return {ch: round(spend[ch] / n, 1) for ch, n in new_users.items() if n > 0}',
  LONG_LINE,
].join('\n')
const REPLY = [
  'Customer acquisition cost by channel last quarter:',
  '',
  '| Channel | New users | Spend | CAC | QoQ |',
  '|---|---|---|---|---|',
  '| Search ads | 1,240 | 186,000 | 150 | −8% |',
  '| Content partners | 860 | 98,900 | 115 | +3% |',
  '| Offline events | 310 | 74,400 | 240 | +21% |',
  '',
  'The calculation, with `spend` and `new_users` summed per channel:',
  '',
  '```python',
  CODE,
  '```',
  '',
  '- Content partners have the lowest CAC and room to grow;',
  '- Offline events vary the most.',
  '',
  'See [report §3.2](https://product.ezarouter.cc/report).',
].join('\n')

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
})

/**
 * 替换页面的 fetch：第 1 次对话请求按块流出 `reply` 后结束；之后的请求只发出一段正文并保持打开，
 * 直到被中止（模拟生成中）。
 */
async function fakeModel(page: Page, messageIds: string[], reply: string) {
  await page.addInitScript(
    ({ messageIds, reply }) => {
      const original = window.fetch
      let calls = 0
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.endsWith('/api/ai/chat')) return original(input, init)
        const encoder = new TextEncoder()
        const line = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        const body = JSON.parse(String(init?.body)) as { conversationId: string }
        const call = calls++
        const messageId = messageIds[call] ?? messageIds[0]
        const stream = new ReadableStream({
          async start(controller) {
            const metadata = { conversationId: body.conversationId, messageId }
            controller.enqueue(line({ type: 'start', messageId, messageMetadata: metadata }))
            controller.enqueue(line({ type: 'start-step' }))
            controller.enqueue(line({ type: 'text-start', id: 't1' }))
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            )
            if (call > 0) {
              controller.enqueue(line({ type: 'text-delta', id: 't1', delta: 'Partial answer' }))
              // 测试经 window.__push 追加正文（跟随滚动与「回到最新」）
              Object.assign(window, {
                __push: (delta: string) =>
                  controller.enqueue(line({ type: 'text-delta', id: 't1', delta })),
              })
              return
            }
            for (let i = 0; i < reply.length; i += 40) {
              controller.enqueue(
                line({ type: 'text-delta', id: 't1', delta: reply.slice(i, i + 40) }),
              )
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            controller.enqueue(line({ type: 'text-end', id: 't1' }))
            controller.enqueue(line({ type: 'finish-step' }))
            controller.enqueue(line({ type: 'finish' }))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
          }),
        )
      }
    },
    { messageIds, reply },
  )
}

/**
 * 写入服务端「已保存、已结算」的回复：页面的流是模拟的，回复结束后对话页按消息 ID 读取保存的版本
 * （正文、状态、积分、模型）替换本地消息。停止的那条比页面看到的多一段，模拟服务端中止前多生成的内容。
 */
async function seedSettledReplies(
  slug: string,
  conversationId: string,
  replies: { id: string; text: string; status: 'completed' | 'aborted'; credits: number }[],
  modelKey: string,
) {
  const sql = fixtureDb()
  try {
    const [workspace] = await sql`select id from organization where slug = ${slug}`
    if (!workspace) throw new Error('Workspace fixture is missing')
    for (const reply of replies)
      await sql`insert into ai_message (id,conversation_id,workspace_id,role,parts,model_key,status,credits)
        values (${reply.id},${conversationId},${workspace.id},'assistant',
          ${sql.json([{ type: 'text', text: reply.text }])},${modelKey},${reply.status},${reply.credits})`
  } finally {
    await sql.end()
  }
}

const SERVER_TAIL = '\n\nServer kept generating this tail before the abort landed.'

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
}

async function shoot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true })
  // 等入场动效与光标结束后再截图
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), animations: 'disabled' })
}

test('chat page renders Markdown replies, copies code, stops and fits 390px (4.5)', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await register(page, `chat-ui-${randomUUID()}@example.com`)
  const slug = slugOf(page)
  const model = await seedChatModel(slug)
  const messageIds = [newId(), newId()]
  const stops: string[] = []
  await page.route('**/api/ai/chat/*/stop', async (route) => {
    stops.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, json: { status: 'aborted' } })
  })
  try {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: 'light' })
    const conversationId = await newConversation(page, slug)
    await fakeModel(page, messageIds, REPLY)
    await chooseSeededModel(page, model.modelId)
    // 选中模型时页面已刷新，之后写入的消息只能经回复结束后的对齐出现
    await seedSettledReplies(
      slug,
      conversationId,
      [
        { id: messageIds[0] as string, text: REPLY, status: 'completed', credits: 2 },
        {
          id: messageIds[1] as string,
          text: `Partial answer${SERVER_TAIL}`,
          status: 'aborted',
          credits: 2,
        },
      ],
      model.key,
    )

    const input = page.locator('[data-input-message] textarea')
    await expect(input).toBeEnabled({ timeout: 30_000 })
    // 只有一行标题：顶部条不显示「对话」，对话区头部的标题是页面唯一的 h1
    await expect(page.getByTestId('app-page-title')).toHaveCount(0)
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveAttribute('data-testid', 'conversation-title')
    // 空态：输入区贴在底部（Main.dc.html 的 empty）
    await shoot(page, 'chat-page-empty-desktop-light')
    await input.fill('Put last quarter CAC by channel in a table, with sample code.')
    await input.press('Enter')

    const replies = page.locator('li[data-role="assistant"]')
    const first = replies.first()
    // Markdown：表格与代码块
    await expect(first.locator('table tbody tr')).toHaveCount(3)
    const code = first.locator('[data-chat-code]')
    await expect(code.locator('pre')).toContainText('def cac(')
    await expect(first.locator('a[href="https://product.ezarouter.cc/report"]')).toHaveAttribute(
      'rel',
      /noopener/,
    )
    // 生成结束：输入区换回发送，回复下方有操作区
    await expect(page.locator('[data-action="send"]')).toBeVisible()
    await expect(first.locator('[data-chat-actions]')).toBeVisible()
    // 不刷新即显示本条回复的结算积分与模型（回复结束后读取保存的消息）
    await expect(first.locator('[data-chat-actions]')).toContainText(`2 credits · ${model.key}`)

    // 代码块复制：剪贴板得到代码原文（不含语言名）
    await code.locator('button').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(CODE)

    await shoot(page, 'chat-page-desktop-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await shoot(page, 'chat-page-desktop-dark')

    // 390px：页面没有横向滚动，长代码行只在代码块内滚动
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    await noHorizontalScroll(page)
    // 代码块的滚动区域可聚焦（键盘可滚动）
    const overflow = await code
      .locator('[tabindex="0"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(overflow).toBe(true)
    await shoot(page, 'chat-page-390-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'chat-page-390-dark')
    await page.emulateMedia({ colorScheme: 'light' })

    // 停止：保留已生成的正文并显示已停止，输入区换回发送
    await input.fill('And the budget?')
    await input.press('Enter')
    const second = replies.nth(1)
    await expect(second).toContainText('Partial answer')
    // 跟随滚动：位于底部时新内容到达自动滚到最新
    const push = (delta: string) =>
      page.evaluate((d) => (window as unknown as { __push(d: string): void }).__push(d), delta)
    const toBottom = () =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.scrollY - window.innerHeight,
      )
    for (let i = 0; i < 12; i++) await push(`\n\nParagraph ${i}: ${'budget detail '.repeat(20)}`)
    await expect(second).toContainText('Paragraph 11')
    await expect.poll(toBottom).toBeLessThan(120)
    // 上翻阅读时不抢滚动位置，出现「回到最新」
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.locator('[data-chat-jump]')).toBeVisible()
    await push('\n\nMore text arriving while reading.')
    await expect(second).toContainText('More text arriving')
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(10)
    await page.locator('[data-chat-jump]').click()
    await expect.poll(toBottom).toBeLessThan(120)
    await expect(page.locator('[data-chat-jump]')).toHaveCount(0)
    await page.locator('[data-action="stop"]').click()
    await expect.poll(() => stops).toEqual([`/api/ai/chat/${messageIds[1]}/stop`])
    await expect(second.locator('[data-chat-status="aborted"]')).toBeVisible()
    await expect(second).toContainText('Partial answer')
    await expect(page.locator('[data-action="send"]')).toBeVisible()
    await noHorizontalScroll(page)
    // 停止后显示的正文换成服务端保存（并计费）的版本，刷新前后一致
    await expect(second).toContainText('Server kept generating this tail')
    await expect(second).not.toContainText('Paragraph 11')
    await expect(second.locator('[data-chat-actions]')).toContainText(`2 credits · ${model.key}`)
    const shown = await second.locator('[data-chat-content]').innerText()
    await page.reload()
    const reloaded = page.locator('li[data-role="assistant"]').nth(1)
    await expect(reloaded.locator('[data-chat-status="aborted"]')).toBeVisible()
    expect(await reloaded.locator('[data-chat-content]').innerText()).toBe(shown)
  } finally {
    await removeModel(model.modelId)
  }
})
