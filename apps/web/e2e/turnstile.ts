import type { Page } from '@playwright/test'

/**
 * 默认用本地桩替换 Turnstile 的浏览器脚本，浏览器不访问外部服务：桩立即回调 Cloudflare 测试 site key
 * 产生的假令牌 `XXXX.DUMMY.TOKEN.XXXX`，服务端仍用 .dev.vars 中的官方测试 secret 真实调用 siteverify。
 * 设 `E2E_REAL_TURNSTILE=1` 时加载真实脚本（官方测试 site key，始终通过）。
 */
export const DUMMY_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

const STUB = `
(() => {
  const widgets = new Map()
  let next = 0
  const issue = (id) => {
    const w = widgets.get(id)
    if (w) setTimeout(() => w.callback(${JSON.stringify(DUMMY_TURNSTILE_TOKEN)}), 50)
  }
  window.turnstile = {
    render(container, options) {
      const id = String(++next)
      widgets.set(id, options)
      container.setAttribute('data-turnstile-stub', id)
      issue(id)
      return id
    },
    reset(id) { issue(id) },
    remove(id) { widgets.delete(id) },
  }
})()
`

export async function stubTurnstile(page: Page) {
  if (process.env.E2E_REAL_TURNSTILE === '1') return
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: STUB }),
  )
}
