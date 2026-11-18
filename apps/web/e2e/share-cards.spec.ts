import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 分享卡片端到端（openspec add-og-images 6.2）：UI_PREVIEW 环境登记示例类型 sample（夹具记录存 KV），
// 平台管理员经 /api/dev/share-cards 创建新令牌与调用失效函数。选择器与断言只用元数据、状态码与图片尺寸，不依赖语言。

/** PNG 的 IHDR 块紧跟 8 字节签名，宽高为大端 32 位整数。 */
function pngSize(body: Buffer) {
  expect([...body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
}

test('share page points og:image at a 1200x630 card and both 404 after invalidation', async ({
  page,
  request,
}) => {
  // 夹具接口要求平台管理员：未登录时 404。
  expect(
    (await request.post('/api/dev/share-cards', { data: { action: 'create' } })).status(),
  ).toBe(404)
  const email = `share-cards-${randomUUID()}@example.com`
  await simulateClientIp(page)
  await stubTurnstile(page)
  await register(page, email)
  const sql = fixtureDb()
  try {
    await sql`update "user" set role='admin' where email=${email}`
  } finally {
    await sql.end()
  }
  const created = await page.request.post('/api/dev/share-cards', { data: { action: 'create' } })
  expect(created.status()).toBe(200)
  const { token, page: sharePath } = (await created.json()) as { token: string; page: string }

  const response = await page.goto(sharePath)
  expect(response?.status()).toBe(200)
  expect(response?.headers()['x-robots-tag']).toBe('noindex')
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/)
  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content')
  expect(ogImage).toBeTruthy()
  const card = new URL(ogImage ?? '')
  expect(card.pathname).toBe(`/share-card/sample/${token}.png`)
  // 项目登记回退字体或站点覆盖时 v 追加一段 8 位指纹（share-cards/meta.ts），两种形态都接受。
  expect(card.searchParams.get('v')).toMatch(/^1-[0-9a-f]{8}(?:-[0-9a-f]{8})?$/)
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', ogImage ?? '')
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  )
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200')
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630')
  // 页面上的卡片图片引用同一地址。
  await expect(page.locator(`img[src="${ogImage}"]`)).toHaveCount(1)

  // 抓取卡片地址：首次渲染，第二次从缓存或对象存储返回同样的字节。
  const cardPath = `${card.pathname}${card.search}`
  // 与页面共用模拟 IP，避免独立 request fixture 累计到其他用例的默认限流桶。
  const image = await page.request.get(cardPath)
  expect(image.status()).toBe(200)
  expect(image.headers()['content-type']).toBe('image/png')
  expect(image.headers()['x-robots-tag']).toBe('noindex')
  expect(image.headers()['cache-control']).toBe('public, max-age=86400, s-maxage=86400')
  const body = await image.body()
  expect(pngSize(body)).toEqual({ width: 1200, height: 630 })
  const again = await page.request.get(cardPath)
  expect(again.status()).toBe(200)
  expect(Buffer.compare(await again.body(), body)).toBe(0)

  // 地址中的摘要过期时 302 到当前地址。
  // 只改 v，保留 l 等其余参数，按同一站点与语言解析。
  const staleURL = new URL(card)
  staleURL.searchParams.set('v', '1-00000000')
  const stale = await page.request.get(`${staleURL.pathname}${staleURL.search}`, {
    maxRedirects: 0,
  })
  expect(stale.status()).toBe(302)
  expect(stale.headers().location).toBe(cardPath)

  const invalidated = await page.request.post('/api/dev/share-cards', {
    data: { action: 'invalidate', token },
  })
  expect(invalidated.status()).toBe(200)
  expect((await page.request.get(cardPath)).status()).toBe(404)
  expect((await page.goto(sharePath))?.status()).toBe(404)
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0)
})

test('malformed tokens and unknown types return 404 for cards and share pages', async ({
  request,
}) => {
  for (const path of [
    '/share-card/sample/short.png?v=1-00000000',
    '/share-card/not-registered/AbCdEfGhIjKlMnOpQrStUv.png?v=1-00000000',
    '/s/sample/short',
    '/s/not-registered/AbCdEfGhIjKlMnOpQrStUv',
  ])
    expect((await request.get(path)).status(), path).toBe(404)
})
