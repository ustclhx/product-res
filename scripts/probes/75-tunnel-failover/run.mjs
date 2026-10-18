#!/usr/bin/env node
// 7.5 实测驱动：持续请求 staging 的 /api/health，期间按场景停止 / 启动 / kill 本机的 cloudflared 副本，
// 记录每个请求的结果与每个容器操作的时刻，结束时汇总每个场景的失败数、中断时长与连接重新注册耗时。
// 用法与前置条件见同目录 README.md。只操作 cloudflared 容器，不触碰 postgres 与任何 Cloudflare 资源。

import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const env = process.env
const URL_ = env.HEALTH_URL ?? 'https://web-staging.product-res-jobs.workers.dev/api/health'
const C1 = env.REPLICA_1 ?? 'product-res-cloudflared-1'
const C2 = env.REPLICA_2 ?? 'product-res-cloudflared-2'
const INTERVAL_MS = Number(env.INTERVAL_MS ?? 300) // 发起请求的间隔（不等待上一个请求返回）
const TIMEOUT_MS = Number(env.TIMEOUT_MS ?? 20_000) // 单个请求的客户端超时
const BASELINE_MS = Number(env.BASELINE_MS ?? 30_000) // 开始操作前的基线
const HOLD_MS = Number(env.HOLD_MS ?? 60_000) // 单副本停止 / kill 后保持的时长
const BOTH_HOLD_MS = Number(env.BOTH_HOLD_MS ?? 30_000) // 两个副本同时停止的时长
const SETTLE_MS = Number(env.SETTLE_MS ?? 45_000) // 启动后观察的时长，之后进入下一个场景
const FINAL_MS = Number(env.FINAL_MS ?? 60_000) // 两个副本全停恢复后的观察时长（需覆盖恢复时间）
const REGISTER_WAIT_MS = Number(env.REGISTER_WAIT_MS ?? 60_000)
const SLOW_MS = Number(env.SLOW_MS ?? 3_000) // 成功但耗时超过它的请求算「受影响」（基线 p95 约 1.2–1.9s）
const PHASE_MS = 20_000 // 操作后统计受影响请求的时长

const ANALYZE = process.argv[2] === '--analyze'
const here = dirname(fileURLToPath(import.meta.url))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = ANALYZE ? process.argv[3] : join(here, 'results', stamp)
if (!ANALYZE) mkdirSync(outDir, { recursive: true })
const reqFile = join(outDir, 'requests.ndjson')
const evFile = join(outDir, 'events.ndjson')

const T0 = Date.now()
const rel = (t) => t - T0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a)

const requests = []
const events = []
function event(type, data = {}) {
  const e = { t: rel(Date.now()), at: new Date().toISOString(), type, ...data }
  events.push(e)
  appendFileSync(evFile, `${JSON.stringify(e)}\n`)
  return e
}

// ---------- 请求循环 ----------
let seq = 0
let polling = true
const inflight = new Set()

async function probeOnce() {
  const r = { seq: seq++, start: rel(Date.now()) }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(URL_, { signal: ctrl.signal, headers: { 'cache-control': 'no-store' } })
    const text = await res.text()
    r.status = res.status
    r.colo = res.headers.get('cf-ray')?.split('-')[1]
    try {
      const body = JSON.parse(text)
      r.db = body.db?.status
      r.dbLatencyMs = body.db?.latencyMs
    } catch {
      r.body = text.slice(0, 200)
    }
  } catch (e) {
    r.status = 0
    r.error = e.name === 'AbortError' ? 'client-timeout' : String(e.cause?.code ?? e.message)
  } finally {
    clearTimeout(timer)
  }
  r.end = rel(Date.now())
  r.ms = r.end - r.start
  r.ok = r.status === 200 && r.db === 'up'
  requests.push(r)
  appendFileSync(reqFile, `${JSON.stringify(r)}\n`)
  if (!r.ok) log(`  ✗ #${r.seq} status=${r.status} db=${r.db ?? '-'} ${r.error ?? ''} ${r.ms}ms`)
}

async function pollLoop() {
  let next = Date.now()
  while (polling) {
    const p = probeOnce()
    inflight.add(p)
    p.finally(() => inflight.delete(p))
    next += INTERVAL_MS
    await sleep(Math.max(0, next - Date.now()))
  }
  await Promise.all(inflight)
}

// ---------- 容器操作 ----------
async function docker(...args) {
  const started = Date.now()
  const { stdout } = await run('docker', args)
  return { stdout: stdout.trim(), tookMs: Date.now() - started }
}

async function containerState(name) {
  const { stdout } = await docker('inspect', '-f', '{{.State.Status}}', name)
  return stdout
}

/** 等待容器在 since 之后输出 n 条 Registered tunnel connection；返回每条相对 since 的耗时（docker 日志时间戳） */
async function waitRegistered(name, sinceIso, n = 2) {
  const since = Date.parse(sinceIso)
  const deadline = Date.now() + REGISTER_WAIT_MS
  while (Date.now() < deadline) {
    const { stdout, stderr } = await run('docker', ['logs', '-t', '--since', sinceIso, name])
    const lines = `${stdout}\n${stderr}`
      .split('\n')
      .filter((l) => l.includes('Registered tunnel connection'))
    if (lines.length >= n) {
      return lines.slice(0, n).map((l) => {
        const ts = l.split(' ')[0]
        return {
          afterStartMs: Date.parse(ts) - since,
          location: l.match(/location=(\S+)/)?.[1],
          connIndex: l.match(/connIndex=(\d+)/)?.[1],
        }
      })
    }
    await sleep(250)
  }
  return null
}

async function stop(name) {
  const e = event('stop', { container: name })
  log(`docker stop ${name}`)
  const { tookMs } = await docker('stop', name)
  event('stopped', { container: name, tookMs, ref: e.t })
  log(`  stopped ${name} (docker stop 耗时 ${tookMs}ms)`)
}

async function kill(name) {
  event('kill', { container: name })
  log(`docker kill ${name}`)
  const { tookMs } = await docker('kill', name)
  event('killed', { container: name, tookMs })
}

async function start(name) {
  const at = new Date().toISOString()
  const e = event('start', { container: name })
  log(`docker start ${name}`)
  await docker('start', name)
  const regs = await waitRegistered(name, at)
  event('registered', { container: name, ref: e.t, regs })
  log(
    regs
      ? `  ${name} 重新注册：${regs.map((r) => `${r.afterStartMs}ms@${r.location}`).join(', ')}`
      : `  ${name} 在 ${REGISTER_WAIT_MS}ms 内未注册 2 条连接`,
  )
  return regs
}

// ---------- 场景 ----------
async function scenario(id, label, body) {
  event('scenario', { id, label })
  log(`=== ${id}: ${label}`)
  await body()
}

async function restoreAll() {
  for (const c of [C1, C2]) {
    try {
      if ((await containerState(c)) !== 'running') {
        log(`恢复：docker start ${c}`)
        await docker('start', c)
      }
    } catch (e) {
      console.error(`恢复 ${c} 失败：${e.message}`)
    }
  }
}

let interrupted = false
process.on('SIGINT', async () => {
  if (interrupted) process.exit(130)
  interrupted = true
  console.error('\n收到 SIGINT：启动所有 cloudflared 副本后退出')
  polling = false
  await restoreAll()
  process.exit(130)
})

async function main() {
  for (const c of [C1, C2]) {
    const st = await containerState(c)
    if (st !== 'running') throw new Error(`${c} 状态为 ${st}，开始前两个副本都必须在运行`)
  }
  writeFileSync(
    join(outDir, 'config.json'),
    JSON.stringify(
      {
        startedAt: new Date(T0).toISOString(),
        URL_,
        C1,
        C2,
        INTERVAL_MS,
        TIMEOUT_MS,
        BASELINE_MS,
        HOLD_MS,
        BOTH_HOLD_MS,
        SETTLE_MS,
        FINAL_MS,
      },
      null,
      2,
    ),
  )
  const loop = pollLoop()

  await scenario('S0', '基线（两个副本都在运行）', async () => {
    await sleep(BASELINE_MS)
  })
  await scenario('S1', `docker stop ${C1}，保持 ${HOLD_MS / 1000}s，再启动`, async () => {
    await stop(C1)
    await sleep(HOLD_MS)
    await start(C1)
    await sleep(SETTLE_MS)
  })
  await scenario('S2', `docker stop ${C2}，保持 ${HOLD_MS / 1000}s，再启动`, async () => {
    await stop(C2)
    await sleep(HOLD_MS)
    await start(C2)
    await sleep(SETTLE_MS)
  })
  await scenario('S3', `docker kill ${C1}，保持 ${HOLD_MS / 1000}s，再启动`, async () => {
    await kill(C1)
    await sleep(HOLD_MS)
    await start(C1)
    await sleep(SETTLE_MS)
  })
  await scenario(
    'S4',
    `两个副本同时 docker stop，保持 ${BOTH_HOLD_MS / 1000}s，再全部启动`,
    async () => {
      await Promise.all([stop(C1), stop(C2)])
      await sleep(BOTH_HOLD_MS)
      await Promise.all([start(C1), start(C2)])
      await sleep(FINAL_MS)
    },
  )

  polling = false
  await loop
  await restoreAll()
  // 保存本次运行期间两个副本的日志（含 graceful shutdown / Unregistered / Registered 行）
  for (const c of [C1, C2]) {
    const { stdout, stderr } = await run('docker', [
      'logs',
      '-t',
      '--since',
      new Date(T0).toISOString(),
      c,
    ])
    writeFileSync(join(outDir, `${c}.log`), `${stdout}${stderr}`)
  }
  const summary = summarize(requests, events)
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  printSummary(summary)
  log(`原始数据：${outDir}`)
}

// ---------- 汇总 ----------
function pct(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

/**
 * 从请求与事件重建每个场景的数据（`--analyze` 也用它）。
 * 请求按「返回时刻」归属场景：操作前已发出、因操作而失败的请求算在该操作的场景里。
 * 首个失败 / 恢复按「发起时刻」排序，时间都相对该场景第一个 stop / kill 操作。
 */
function summarize(requests, events) {
  const rs = [...requests].sort((a, b) => a.start - b.start)
  const marks = events.filter((e) => e.type === 'scenario')
  const lastEnd = Math.max(...rs.map((r) => r.end))
  return marks.map((m, i) => {
    const from = m.t
    const to = marks[i + 1]?.t ?? lastEnd + 1
    const evs = events.filter((e) => e.t >= from && e.t < to)
    const inWin = rs.filter((r) => r.end >= from && r.end < to)
    const fails = inWin.filter((r) => !r.ok)
    const okMs = inWin.filter((r) => r.ok).map((r) => r.ms)
    const action = evs.find((e) => e.type === 'stop' || e.type === 'kill')
    const t0 = action?.t ?? from
    const startEv = evs.find((e) => e.type === 'start')
    const out = {
      id: m.id,
      label: m.label,
      requests: inWin.length,
      failed: fails.length,
      failureKinds: fails.reduce((acc, r) => {
        const k = r.error ?? `${r.status}/${r.db ?? '-'}`
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {}),
      okLatency: {
        p50: pct(okMs, 50),
        p95: pct(okMs, 95),
        max: okMs.length ? Math.max(...okMs) : null,
      },
      stopTookMs: Object.fromEntries(
        evs.filter((e) => e.type === 'stopped').map((e) => [e.container, e.tookMs]),
      ),
      registered: Object.fromEntries(
        evs
          .filter((e) => e.type === 'registered')
          .map((e) => [e.container, e.regs?.map((r) => r.afterStartMs) ?? null]),
      ),
    }
    if (fails.length) {
      const first = fails[0]
      const last = fails[fails.length - 1]
      const recovered = rs.find((r) => r.ok && r.start > last.start)
      out.firstFailureStart = first.start - t0
      out.lastFailureStart = last.start - t0
      out.recoveredStart = recovered ? recovered.start - t0 : null
      // 中断时长：首个失败请求发起 → 其后首个成功请求发起
      out.outageMs = recovered ? recovered.start - first.start : null
      out.failedMs = {
        min: Math.min(...fails.map((r) => r.ms)),
        max: Math.max(...fails.map((r) => r.ms)),
      }
    }
    // 受影响 = 失败或耗时超过 SLOW_MS；分「停止 / kill 后」与「启动后」两个阶段统计，
    // 「停止后」为操作前 2s（覆盖操作时在途的请求）到 docker start，「启动后」为启动后 PHASE_MS
    const phase = (a, b, lead = 0) => {
      const hit = rs.filter((r) => r.start >= a - lead && r.start < b && (!r.ok || r.ms > SLOW_MS))
      if (!hit.length) return { failed: 0, slowOk: 0 }
      return {
        failed: hit.filter((r) => !r.ok).length,
        slowOk: hit.filter((r) => r.ok).length,
        // 受影响请求的发起区间与最后一个受影响请求返回的时刻（相对操作）
        firstStart: hit[0].start - a,
        lastStart: hit[hit.length - 1].start - a,
        lastEnd: Math.max(...hit.map((r) => r.end)) - a,
      }
    }
    if (action) out.afterStop = phase(t0, startEv?.t ?? to, 2_000)
    if (startEv) {
      const s0 = startEv.t
      out.startAt = s0 - t0
      out.afterStart = phase(s0, Math.min(to, s0 + PHASE_MS))
      const firstOk = rs.find((r) => r.ok && r.start >= s0)
      out.firstOkAfterStartMs = firstOk ? firstOk.start - s0 : null
    }
    return out
  })
}

function printSummary(sum) {
  console.log('\n时间单位 ms，相对场景中第一个 stop / kill；请求按返回时刻归属场景')
  for (const s of sum) {
    console.log(`\n${s.id} ${s.label}`)
    console.log(
      `  请求 ${s.requests}，失败 ${s.failed} ${JSON.stringify(s.failureKinds)}；成功请求 p50/p95/max = ${s.okLatency.p50}/${s.okLatency.p95}/${s.okLatency.max}`,
    )
    if (s.failed)
      console.log(
        `  首个失败发起 ${s.firstFailureStart}，最后失败发起 ${s.lastFailureStart}，其后首个成功发起 ${s.recoveredStart}（中断 ${s.outageMs}）；失败请求耗时 ${s.failedMs.min}–${s.failedMs.max}`,
      )
    if (s.afterStop) console.log(`  停止 / kill 至启动前受影响：${JSON.stringify(s.afterStop)}`)
    if (Object.keys(s.stopTookMs).length)
      console.log(`  docker stop 耗时 ${JSON.stringify(s.stopTookMs)}`)
    if (s.startAt !== undefined)
      console.log(
        `  启动于 ${s.startAt}；启动后首个成功请求 +${s.firstOkAfterStartMs}；启动后受影响：${JSON.stringify(s.afterStart)}；重新注册（距 docker start）${JSON.stringify(s.registered)}`,
      )
  }
}

const readNdjson = (f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

if (ANALYZE) {
  const sum = summarize(readNdjson(reqFile), readNdjson(evFile))
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(sum, null, 2))
  printSummary(sum)
} else
  main().catch(async (e) => {
    console.error(e)
    polling = false
    await restoreAll()
    process.exit(1)
  })
