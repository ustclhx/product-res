// 7.4 延迟基线探针（docs/07-infrastructure.md §8）。
// 每个 HTTP 请求新建一个 postgres.js 客户端（与 createDb 的用法一致），对 Hyperdrive（关缓存）
// 顺序执行同一查询 1 + REUSE 次：第 1 次包含与 Hyperdrive 建连，其余复用同一连接。
// Workers 中计时只在 I/O 时推进，测得的就是等待数据库的时间。
import postgres from 'postgres'

const KEY = 'probe.7.4.latency'
const DEFAULT_REUSE = 5

async function executionColo() {
  // Worker 发出的子请求从 Worker 实际运行的机房出站，trace 中的 colo 即执行位置
  const text = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then((r) => r.text())
  return /^colo=(\w+)$/m.exec(text)?.[1] ?? null
}

// 从本 Worker 的执行位置（如显式放置到 FRA 的 probe-74-latency-eu）请求另一个 probe Worker，
// 使目标 Worker 的入口机房不在本机附近：/relay?to=smart&prepare=1
async function relay(url) {
  const to = url.searchParams.get('to')
  if (!/^[a-z]+$/.test(to ?? '')) return new Response('bad target', { status: 400 })
  const host = url.hostname.replace(/^probe-74-latency-[a-z]+\./, `probe-74-latency-${to}.`)
  const target = `https://${host}/probe?prepare=${url.searchParams.get('prepare') ?? '1'}`
  const start = Date.now()
  const response = await fetch(target, { headers: { 'cache-control': 'no-store' } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return Response.json({ error: text.slice(0, 500), status: response.status }, { status: 502 })
  }
  return Response.json(
    {
      ...body,
      relayColo: await executionColo(),
      relayMs: Date.now() - start,
      placement: response.headers.get('cf-placement'),
    },
    { status: response.status },
  )
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/relay') return relay(url)
    if (url.pathname !== '/probe') return new Response('not found', { status: 404 })
    const reuse = Math.min(Math.max(Number(url.searchParams.get('reuse') ?? DEFAULT_REUSE), 1), 20)
    // 默认与 packages/db 的 createDb 相同（prepare: true）；?prepare=0 作为对照组
    const prepare = url.searchParams.get('prepare') !== '0'

    // 不调用 sql.end()（docs/07 §3 已知问题）
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare })
    const timings = []
    let found = false
    try {
      for (let i = 0; i <= reuse; i++) {
        const start = Date.now()
        const rows = await sql`select value from setting where key = ${KEY}`
        timings.push(Date.now() - start)
        found = rows.length === 1
      }
    } catch (error) {
      return Response.json(
        { error: String(error?.message ?? error), timings, requestColo: request.cf?.colo },
        { status: 503 },
      )
    }

    return Response.json({
      worker: env.PROBE_NAME,
      requestColo: request.cf?.colo ?? null,
      executionColo: await executionColo(),
      prepare,
      firstMs: timings[0],
      reusedMs: timings.slice(1),
      found,
    })
  },
}
