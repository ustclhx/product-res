// 7.3 实测客户端：依次发起各个场景，在 disconnect 秒后主动断开（AbortController 关闭连接），
// 等源流应结束的时间过去后读取 /results，打印每个场景服务端读到的块数与最后一次写库时间。
//
// 用法：node scripts/probes/stream-7_3/run.mjs <worker 地址> [场景过滤，如 tee-60]
const base = process.argv[2]
const filter = process.argv[3]
if (!base) {
  console.error('usage: node run.mjs https://probe-73-stream.<subdomain>.workers.dev [filter]')
  process.exit(1)
}

const INTERVAL = 500
const tag = Date.now().toString(36)
// remaining = 断开（或响应结束）后源流还需要的秒数
const scenarios = [
  { name: 'baseline-20', mode: 'tee', total: 20, disconnect: null },
  { name: 'tee-10', mode: 'tee', total: 15, disconnect: 5 },
  { name: 'tee-30', mode: 'tee', total: 35, disconnect: 5 },
  { name: 'tee-60', mode: 'tee', total: 65, disconnect: 5 },
  { name: 'tee-120', mode: 'tee', total: 125, disconnect: 5 },
  { name: 'tee-300', mode: 'tee', total: 305, disconnect: 5 },
  { name: 'nowait-30', mode: 'nowait', total: 35, disconnect: 5 },
  { name: 'detached-10', mode: 'detached', total: 10, disconnect: null },
  { name: 'detached-30', mode: 'detached', total: 30, disconnect: null },
  { name: 'detached-60', mode: 'detached', total: 60, disconnect: null },
  { name: 'detached-120', mode: 'detached', total: 120, disconnect: null },
].filter((s) => !filter || s.name.startsWith(filter))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runOne(s) {
  const run = `${tag}-${s.name}`
  const qs = new URLSearchParams({
    run,
    mode: s.mode,
    total: String(s.total),
    interval: String(INTERVAL),
  })
  const ac = new AbortController()
  const t0 = Date.now()
  const res = await fetch(`${base}/stream?${qs}`, { signal: ac.signal })
  if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status} ${await res.text()}`)
  let received = 0
  let lastServerAt = null
  const decoder = new TextDecoder()
  if (s.disconnect !== null) setTimeout(() => ac.abort(), s.disconnect * 1000)
  try {
    for await (const part of res.body) {
      for (const m of decoder
        .decode(part, { stream: true })
        .matchAll(/"chunk":(\d+),"at":(\d+)/g)) {
        received = Number(m[1])
        lastServerAt = Number(m[2])
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e
  }
  const clientSeconds = (Date.now() - t0) / 1000
  console.log(
    `${s.name}: client ${s.disconnect === null ? 'read to end' : 'aborted'} after ${clientSeconds.toFixed(1)}s, received ${received} chunks`,
  )
  return { ...s, run, t0, received, lastServerAt, clientSeconds }
}

const runs = []
for (const s of scenarios) {
  const r = await runOne(s)
  runs.push(r)
  // 场景串行执行：等源流按计划应结束后再留 15s 余量，避免多个请求共用 isolate 互相影响
  await sleep(Math.max(0, r.t0 + s.total * 1000 + 15000 - Date.now()))
}

const rows = await (await fetch(`${base}/results`)).json()
const byKey = new Map(rows.map((r) => [r.key, r]))
const table = runs.map((r) => {
  const k = (suffix) => byKey.get(`probe.7_3.${r.run}.${suffix}`)
  const done = k('done')
  const progress = k('progress')
  const error = k('error')
  const expected = Math.ceil((r.total * 1000) / INTERVAL)
  const last = done ?? error ?? progress
  return {
    scenario: r.name,
    mode: r.mode,
    sourceSec: r.total,
    clientSec: Number(r.clientSeconds.toFixed(1)),
    clientChunks: r.received,
    expected,
    serverChunks: last?.value.chunks ?? 0,
    serverDone: Boolean(done),
    lastWriteSec: last ? Number((last.value.elapsedMs / 1000).toFixed(1)) : null,
    error: error?.value.error ?? '',
  }
})
console.table(table)
console.log(JSON.stringify(table))
