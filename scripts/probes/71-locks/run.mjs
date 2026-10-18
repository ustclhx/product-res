#!/usr/bin/env node
// 7.1 实测驱动：对部署后的 probe-71-locks 发起两个并发请求争同一把锁，并检查锁是否释放。
// 用法：PROBE_URL=https://probe-71-locks.<子域>.workers.dev PROBE_TOKEN=... node run.mjs [轮数]
// 输出每个场景的原始 JSON 与判定；任一判定失败时以非零码退出。

const { PROBE_URL: BASE, PROBE_TOKEN: TOKEN, KEEP_ROWS } = process.env
if (!BASE || !TOKEN) {
  console.error('需要环境变量 PROBE_URL 与 PROBE_TOKEN')
  process.exit(2)
}
const ROUNDS = Number(process.argv[2] ?? 3)
const A_HOLD = 3000 // 先到者持锁时长
const B_HOLD = 500
const B_DELAY = 800 // 后到者比先到者晚发出的时间，保证 A 先拿到锁

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(path, params = {}) {
  const url = new URL(path, BASE)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { 'x-probe-token': TOKEN } })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  } catch {
    return { status: res.status, text }
  }
}

const failures = []
function expect(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

const fmt = (ms) => `${Math.round(ms)}ms`

// 锁是否释放：串行 5 次 try-lock（落在连接池中的不同连接上，pid 见输出），
// 再并发 5 次只读检查 pg_locks（并发的 try-lock 会互相争锁，故不并发）
async function checkReleased(label) {
  const tries = []
  for (let i = 0; i < 5; i++) tries.push(await call('/check', { tryLock: 1 }))
  const views = await Promise.all(Array.from({ length: 5 }, () => call('/check')))
  const pids = [...new Set([...tries, ...views].map((r) => r.pid))]
  const idle = views.flatMap((r) => r.idleInTransaction ?? []).map((x) => x.pid)
  console.log(
    `  check(${label}) pids=${pids.join(',')} idleInTransaction=[${[...new Set(idle)].join(',')}]`,
  )
  expect(
    tries.every((r) => r.status === 200 && r.advisoryLockFree && r.rowLockFree),
    `${label}: 5 个新事务均能立即拿到 advisory lock 与行锁（try / NOWAIT）`,
  )
  expect(
    [...tries, ...views].every((r) => r.otherAdvisoryHolders === 0),
    `${label}: pg_locks 中无其他会话持有该 advisory key`,
  )
  return { tries, views, pids }
}

async function scenario(mode, end, round) {
  const name = `${mode}/${end}#${round}`
  console.log(`\n== ${name}`)
  const before = (await call('/check')).counter
  const pA = call('/lock', { mode, end, hold: A_HOLD, tag: 'A' })
  await sleep(B_DELAY)
  const pB = call('/lock', { mode, end: 'commit', hold: B_HOLD, tag: 'B' })
  const [a, b] = await Promise.all([pA, pB])
  console.log('  A', JSON.stringify(a))
  console.log('  B', JSON.stringify(b))
  expect(a.status === 200 && b.status === 200, `${name}: 两个请求都成功`)
  if (a.status !== 200 || b.status !== 200) return { name, a, b }
  expect(a.pid !== b.pid, `${name}: A、B 使用不同的后端连接（pid ${a.pid} / ${b.pid}）`)
  expect(b.beginAt < a.acquiredAt + A_HOLD, `${name}: B 在 A 持锁期间开始事务`)

  // A 释放锁的时刻：commit / rollback 为 A 事务结束（endedAt 之前），abandon 为未知
  const aRelease = end === 'abandon' ? a.respondedAt : a.releaseAt
  expect(
    b.acquiredAt >= aRelease,
    `${name}: B 拿到锁(${fmt(b.acquiredAt - a.beginAt)}) 晚于 A ${end === 'abandon' ? '响应返回' : '持锁结束'}(${fmt(aRelease - a.beginAt)})`,
  )
  const expectedBefore = end === 'commit' ? before + 1 : before
  expect(
    b.counterBefore === expectedBefore,
    `${name}: B 读到的计数器 = ${b.counterBefore}（期望 ${expectedBefore}，A ${end === 'commit' ? '已提交' : '的更新未生效'}）`,
  )
  console.log(
    `  A 持锁 ${fmt(aRelease - a.acquiredAt)}；B 等待 ${fmt(b.waitMs)}；B 在 A 释放后 ${fmt(b.acquiredAt - aRelease)} 获得锁` +
      (a.endedAt ? `；A 事务结束后首个时间点距 A 持锁结束 ${fmt(a.endedAt - aRelease)}` : ''),
  )
  await checkReleased(name)
  return { name, a, b }
}

// 对照组：不加锁时 B 不等待，读到 A 提交前的旧值，最终丢失一次更新
async function control(round) {
  const name = `none/commit#${round}`
  console.log(`\n== ${name}（对照组，不加锁）`)
  const before = (await call('/check')).counter
  const pA = call('/lock', { mode: 'none', hold: A_HOLD, tag: 'A' })
  await sleep(B_DELAY)
  const pB = call('/lock', { mode: 'none', hold: B_HOLD, tag: 'B' })
  const [a, b] = await Promise.all([pA, pB])
  console.log('  A', JSON.stringify(a))
  console.log('  B', JSON.stringify(b))
  const after = (await call('/check')).counter
  expect(a.status === 200 && b.status === 200, `${name}: 两个请求都成功`)
  expect(b.acquiredAt < a.releaseAt, `${name}: B 未等待 A（B 等待 ${fmt(b.waitMs)}）`)
  expect(
    b.counterBefore === before && after === before + 1,
    `${name}: B 读到旧值 ${b.counterBefore}，两次 +1 后计数器 ${before} → ${after}（丢失一次更新）`,
  )
  return { name, a, b }
}

async function main() {
  const setup = await call('/setup')
  console.log('setup', JSON.stringify(setup).slice(0, 300))
  if (setup.status !== 200) {
    console.error('setup 失败（新部署的 workers.dev 路由可能尚未生效，稍后重试）')
    process.exit(1)
  }
  await checkReleased('初始')
  const summary = []
  for (let round = 1; round <= ROUNDS; round++) {
    const c = await control(round)
    if (c.a.status === 200 && c.b.status === 200) {
      summary.push({
        scenario: c.name,
        aHoldMs: Math.round(c.a.releaseAt - c.a.acquiredAt),
        bWaitMs: Math.round(c.b.waitMs),
        bAfterReleaseMs: Math.round(c.b.acquiredAt - c.a.releaseAt),
      })
    }
    for (const mode of ['row', 'advisory']) {
      for (const end of ['commit', 'rollback', 'abandon']) {
        const r = await scenario(mode, end, round)
        if (r.a?.status === 200 && r.b?.status === 200) {
          const aRelease = end === 'abandon' ? r.a.respondedAt : r.a.releaseAt
          summary.push({
            scenario: r.name,
            aHoldMs: Math.round(aRelease - r.a.acquiredAt),
            bWaitMs: Math.round(r.b.waitMs),
            bAfterReleaseMs: Math.round(r.b.acquiredAt - aRelease),
          })
        }
      }
    }
  }
  // 大量请求之后，连接池中的连接仍不残留锁
  await checkReleased('全部场景之后')
  console.log('\n== 汇总')
  console.table(summary)
  if (KEEP_ROWS !== '1') console.log('cleanup', JSON.stringify(await call('/cleanup')))
  if (failures.length > 0) {
    console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\n全部通过')
}

await main()
