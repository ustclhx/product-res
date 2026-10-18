#!/usr/bin/env node
// 7.2 实测驱动脚本：对已部署的 probe-72-caller 依次执行各场景，结果以 JSON 输出到 stdout。
// 用法见 README.md：
//   PROBE_URL=https://probe-72-caller.<子域名>.workers.dev PROBE_TOKEN=... node run.mjs [场景...]
//   场景：baseline early-sleep before-start multi dot-type after-complete
//         retention-start <state.json> / retention-check <state.json>
// 不带参数时运行除 retention-* 之外的全部场景。

import { readFileSync, writeFileSync } from 'node:fs'

// 手动运行的脚本，不是 turbo 任务，不需要在 turbo.json 中声明
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 见上
const BASE = process.env.PROBE_URL
// biome-ignore lint/suspicious/noUndeclaredEnvVars: 见上
const TOKEN = process.env.PROBE_TOKEN
if (!BASE || !TOKEN) {
  console.error('需要环境变量 PROBE_URL 与 PROBE_TOKEN')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status !== 200)
    throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const create = (params) => call('POST', '/create', { params })
const createAndSend = (params, events) => call('POST', '/create-and-send', { params, events })
const status = (id) => call('GET', `/status?id=${encodeURIComponent(id)}`)
const send = (id, type, payload) => call('POST', '/event', { id, type, payload })

const TERMINAL = new Set(['complete', 'errored', 'terminated'])

/** 轮询直到状态满足条件；返回最后一次状态及经历过的状态序列 */
async function until(id, pred, timeoutMs = 180_000) {
  const seen = []
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await status(id)
    const st = s.ok ? s.value.status : `error:${s.error}`
    if (seen.at(-1) !== st) seen.push(st)
    if (!s.ok || pred(s.value) || Date.now() > deadline) return { last: s, seen }
    await sleep(1000)
  }
}
const done = (id, timeoutMs) => until(id, (v) => TERMINAL.has(v.status), timeoutMs)

function created(r) {
  if (!r.ok) throw new Error(`create failed: ${r.error}`)
  return r.value.id
}

const scenarios = {
  /**
   * 基线：跨 Worker 创建 → 实例进入 waitForEvent 后 sendEvent → 完成并拿到 payload。
   * 实测 waitForEvent 期间 status() 仍为 'running'（不会出现 'waiting'），
   * 因此只能等实例开始运行后再固定等待 10 秒，并记录这段时间内观察到的状态。
   */
  async baseline() {
    const c = await create({ sleepSeconds: 0, waits: [{ type: 'probe', timeout: '2 minutes' }] })
    const id = created(c)
    const running = await until(id, (v) => v.status !== 'queued')
    const during = await until(id, () => false, 10_000)
    const sent = await send(id, 'probe', { seq: 1, sentAt: Date.now() })
    const end = await done(id)
    return {
      id,
      createStatus: c.value.status,
      running: running.seen,
      during: during.seen,
      sent,
      end,
    }
  },

  /** 实例在 step.sleep(30s) 中时先发事件，之后进入 waitForEvent 能否收到 */
  async 'early-sleep'() {
    const c = await create({ sleepSeconds: 30, waits: [{ type: 'probe', timeout: '1 minute' }] })
    const id = created(c)
    await sleep(5000)
    const sent = await send(id, 'probe', { seq: 1, sentAt: Date.now() })
    const end = await done(id)
    return { id, sent, end }
  },

  /** 同一次调用中 create 后立即 sendEvent（实例尚未开始执行） */
  async 'before-start'() {
    const r = await createAndSend(
      { sleepSeconds: 0, waits: [{ type: 'probe', timeout: '1 minute' }] },
      [{ type: 'probe', payload: { seq: 1 } }],
    )
    const end = await done(r.id)
    return { ...r, end }
  },

  /**
   * 多个事件先于 waitForEvent 到达：a#1、a#2、b#3、other#4。
   * 依次等待 b、a、a、a(15s)：验证按 type 匹配、同 type 的事件是否逐个保留以及先后顺序，
   * 以及不同 type 的事件不会被误投递（最后一个 a 应超时）。
   */
  async multi() {
    const r = await createAndSend(
      {
        sleepSeconds: 10,
        waits: [
          { type: 'b', timeout: '1 minute' },
          { type: 'a', timeout: '1 minute' },
          { type: 'a', timeout: '1 minute' },
          { type: 'a', timeout: '15 seconds' },
        ],
      },
      [
        { type: 'a', payload: { seq: 1 } },
        { type: 'a', payload: { seq: 2 } },
        { type: 'b', payload: { seq: 3 } },
        { type: 'other', payload: { seq: 4 } },
      ],
    )
    const end = await done(r.id)
    return { ...r, end }
  },

  /** docs/06-ai.md 中使用的 type 'media.done'（含 '.'）：sendEvent 与 waitForEvent 各自的行为 */
  async 'dot-type'() {
    const r = await createAndSend(
      {
        sleepSeconds: 0,
        waits: [
          { type: 'media.done', timeout: '20 seconds' },
          { type: 'media-done', timeout: '20 seconds' },
        ],
      },
      [
        { type: 'media.done', payload: { seq: 1 } },
        { type: 'media-done', payload: { seq: 2 } },
      ],
    )
    const end = await done(r.id)
    return { ...r, end }
  },

  /** 实例完成后再 sendEvent；以及对不存在的实例 get / sendEvent */
  async 'after-complete'() {
    const r = await createAndSend(
      { sleepSeconds: 0, waits: [{ type: 'probe', timeout: '1 minute' }] },
      [{ type: 'probe', payload: { seq: 1 } }],
    )
    const end = await done(r.id)
    const sentAfterComplete = await send(r.id, 'probe', { seq: 2 })
    const missing = await send(`probe-72-missing-${Date.now()}`, 'probe', { seq: 3 })
    return { id: r.id, endStatus: end.last.value?.status, sentAfterComplete, missing }
  },
}

/** 保留时长：sleep N 秒后才进入 waitForEvent，事件在创建后立即发送 */
const RETENTION_SLEEPS = [60, 300, 900, 3600]

async function retentionStart(file) {
  const started = []
  for (const sleepSeconds of RETENTION_SLEEPS) {
    const r = await createAndSend(
      { sleepSeconds, waits: [{ type: 'probe', timeout: '5 minutes' }] },
      [{ type: 'probe', payload: { sleepSeconds, sentAt: Date.now() } }],
    )
    started.push({ sleepSeconds, id: r.id, createdAt: r.createdAt, sends: r.sends })
  }
  writeFileSync(file, JSON.stringify(started, null, 2))
  return started
}

async function retentionCheck(file) {
  const started = JSON.parse(readFileSync(file, 'utf8'))
  const out = []
  for (const s of started) out.push({ ...s, status: await status(s.id) })
  return out
}

const args = process.argv.slice(2)
if (args[0] === 'retention-start' || args[0] === 'retention-check') {
  const fn = args[0] === 'retention-start' ? retentionStart : retentionCheck
  console.log(JSON.stringify({ scenario: args[0], result: await fn(args[1]) }, null, 2))
} else {
  const names = args.length > 0 ? args : Object.keys(scenarios)
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return { scenario: name, result: await scenarios[name]() }
      } catch (e) {
        return { scenario: name, error: String(e) }
      }
    }),
  )
  console.log(JSON.stringify(results, null, 2))
}
