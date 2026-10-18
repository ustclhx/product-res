// 仅由本地验收 Compose 通过 Node --import 加载，不进入镜像或生产配置。
const originalFetch = globalThis.fetch
const resendOrigin = 'https://api.resend.com'
const captureURL = 'http://capture:8025/emails'

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== 'api.resend.com') return originalFetch(input, init)
  // 不允许 Resend 的其他路径绕过捕获服务并实际发信。
  if (url.origin !== resendOrigin || url.pathname !== '/emails' || url.search || url.hash) {
    throw new Error('Selfhost acceptance blocks uncaptured Resend requests')
  }
  const request = new Request(input, init)
  if (request.method !== 'POST') {
    throw new Error('Selfhost acceptance only captures email delivery POST requests')
  }
  const headers = new Headers(request.headers)
  headers.delete('authorization')
  return originalFetch(captureURL, {
    method: request.method,
    headers,
    body: await request.arrayBuffer(),
    signal: request.signal,
    redirect: 'error',
  })
}
