// 在真实 Node 容器执行；只输出固定结果，页面与响应正文不进入验收日志。
function check(condition, reason) {
  if (!condition) throw new Error(reason)
}
const get = (path) =>
  fetch(`http://127.0.0.1:3000${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  })
const home = await get('/')
check(
  [301, 302, 303, 307, 308].includes(home.status) &&
    new URL(home.headers.get('location'), 'http://local').pathname === '/app',
  'Application homepage does not lead to /app',
)
// 单语言构建仍使用默认语言文案，按实际中文表单名验证 SSR。
const login = await get('/login')
const html = await login.text()
check(
  login.status === 200 &&
    /<html[^>]*lang="zh"/.test(html) &&
    html.includes('aria-label="使用密码登录"') &&
    !html.includes('aria-label="Sign in with password"'),
  'Chinese single-language Node SSR failed',
)
const assets = [
  ...new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))(?:[^" ]*)"/g)].map(
      (match) => match[1],
    ),
  ),
]
check(
  assets.some((path) => path.endsWith('.js')) && assets.some((path) => path.endsWith('.css')),
  'SSR did not reference JavaScript and CSS assets',
)
for (const asset of assets) {
  const response = await get(asset)
  check(
    response.status === 200 && (await response.arrayBuffer()).byteLength > 0,
    'Static asset request failed',
  )
}
for (const path of [
  '/pricing',
  '/blog',
  '/docs',
  '/waitlist',
  '/newsletter',
  '/en',
  '/zh',
  '/en/login',
  '/zh/login',
  '/en/app',
  '/zh/app',
])
  check((await get(path)).status === 404, `Disabled route is still available: ${path}`)
console.info('SSR, static assets and disabled routes passed')
