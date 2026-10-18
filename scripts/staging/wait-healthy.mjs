import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export async function waitHealthy(
  url,
  expectedVersion,
  { intervalMs = 5_000, timeoutMs = 180_000, write = console.error } = {},
) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const started = performance.now()
    let status = null
    let version = null
    let healthy = false
    try {
      // 单次请求也受总时限约束，避免无响应的端点使发布无限等待。
      const response = await fetch(url, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(Math.min(intervalMs, deadline - started))),
        ),
        redirect: 'error',
      })
      status = response.status
      const body = await response.json()
      version = typeof body?.version === 'string' ? body.version : null
      healthy = status === 200 && body?.db?.status === 'up' && version === expectedVersion
    } catch {
      // 不输出网络异常、URL 或响应正文，避免泄漏数据库与认证信息。
    }
    if (healthy) return 0
    write(JSON.stringify({ status, version }))
    const delay = Math.min(intervalMs - (performance.now() - started), deadline - performance.now())
    if (delay > 0) await sleep(delay)
  }
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [url, expectedVersion] = process.argv.slice(2)
  if (!url || !expectedVersion) {
    console.error('Usage: node scripts/staging/wait-healthy.mjs <health URL> <expected version>')
    process.exitCode = 1
  } else {
    process.exitCode = await waitHealthy(url, expectedVersion)
  }
}
