import { evidence, expect, login, test } from './support.ts'

test('Sentry 1.2: same-origin administrator test exception', async ({ page }) => {
  await login(page, 'admin')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(page.url()).hostname)
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/admin/observability/sentry-test', { method: 'POST' })
    return { status: response.status, requestId: response.headers.get('x-request-id') }
  })
  await evidence('sentry-test', {
    ...result,
    status: result.status,
    state: local ? 'local-sentry-disabled' : 'sentry-event-pending-manual-verification',
  })
  // 本地未配置 Sentry 的 503 只验证权限入口，不计为 staging 错误上报验收。
  expect(result.status).toBe(local ? 503 : 500)
  expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/i)
})
