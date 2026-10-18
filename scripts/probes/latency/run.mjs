#!/usr/bin/env node
// 7.4 延迟基线：依次请求各个 probe-74-* Worker，汇总 Worker 内部测得的数据库往返（README.md）。
// 用法：node scripts/probes/latency/run.mjs [--n 60] [--workers off,smart,eu,ap] [--prepare 0] [--via eu] [--out file.json]
//   --via eu：经 probe-74-latency-eu 的 /relay 转发，使目标 Worker 的入口机房在 FRA（README.md）

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    n: { type: 'string', default: '60' },
    workers: { type: 'string', default: 'off,smart,eu,ap' },
    subdomain: { type: 'string', default: 'product-res-jobs' },
    prepare: { type: 'string', default: '1' },
    via: { type: 'string' },
    out: { type: 'string' },
  },
})
const n = Number(values.n)

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function summarize(samples) {
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    min: Math.min(...samples),
    max: Math.max(...samples),
  }
}

function tally(items) {
  const counts = {}
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1
  return counts
}

async function probe(worker) {
  const base = `.${values.subdomain}.workers.dev`
  const url = values.via
    ? `https://probe-74-latency-${values.via}${base}/relay?to=${worker}&prepare=${values.prepare}`
    : `https://probe-74-latency-${worker}${base}/probe?prepare=${values.prepare}`
  const samples = []
  for (let i = 0; i < n; i++) {
    const start = performance.now()
    const response = await fetch(url, { headers: { 'cache-control': 'no-store' } })
    const clientMs = Math.round(performance.now() - start)
    const body = await response.json()
    if (!response.ok) throw new Error(`${worker}: HTTP ${response.status} ${JSON.stringify(body)}`)
    samples.push({ placement: response.headers.get('cf-placement'), ...body, clientMs })
  }
  return {
    worker,
    prepare: values.prepare !== '0',
    via: values.via ?? null,
    requests: n,
    requestColo: tally(samples.map((s) => s.requestColo)),
    executionColo: tally(samples.map((s) => s.executionColo)),
    placement: tally(samples.map((s) => s.placement ?? '(none)')),
    firstMs: summarize(samples.map((s) => s.firstMs)),
    reusedMs: summarize(samples.flatMap((s) => s.reusedMs)),
    clientMs: summarize(samples.map((s) => s.clientMs)),
    samples,
  }
}

const results = []
for (const worker of values.workers.split(',')) {
  const result = await probe(worker)
  results.push(result)
  const { samples: _, ...summary } = result
  console.log(JSON.stringify(summary))
}

console.log(
  '\n| Worker | 请求机房 | 执行机房 | cf-placement | 首次建连 p50/p95 | 复用连接 p50/p95 | 客户端总耗时 p50/p95 |',
)
console.log('|---|---|---|---|---|---|---|')
for (const r of results) {
  const fmt = (s) => `${s.p50} / ${s.p95} ms`
  const keys = (o) => Object.keys(o).join(', ')
  console.log(
    `| ${r.worker} | ${keys(r.requestColo)} | ${keys(r.executionColo)} | ${keys(r.placement)} | ${fmt(r.firstMs)} | ${fmt(r.reusedMs)} | ${fmt(r.clientMs)} |`,
  )
}

if (values.out) {
  writeFileSync(
    values.out,
    `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
  )
}
