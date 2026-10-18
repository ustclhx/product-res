// 7.3 实测：客户端中途断开后，ctx.waitUntil 能否把模拟的 LLM 流读完并写库，以及能多读多久。
//
// GET  /stream?run=<id>&total=<秒>&interval=<毫秒>&mode=<tee|nowait|detached>
//   源流每 interval 毫秒产出一块，共持续 total 秒（模拟 streamText 的模型流）。
//   - tee：     源流 tee 成两路，一路作为响应体，另一路在 ctx.waitUntil 中读完
//               （AI SDK `ctx.waitUntil(result.consumeStream())` 的等价结构）
//   - nowait：  同 tee，但读完的 promise 不交给 waitUntil（对照组）
//   - detached：立即返回一个短响应，源流只在 waitUntil 中读完（测响应结束后的余量）
//   服务端读的过程中每 5 秒写一次 probe.7_3.<run>.progress，读完写 probe.7_3.<run>.done。
// GET  /results            列出 probe.7_3.* 行
// POST /cleanup            删除 probe.7_3.* 行
import postgres from 'postgres'

const PREFIX = 'probe.7_3.'
const PROGRESS_EVERY_MS = 5000

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/stream') return stream(url, env, ctx)
    if (url.pathname === '/results') return results(env)
    if (url.pathname === '/cleanup' && request.method === 'POST') return cleanup(env)
    return new Response('not found', { status: 404 })
  },
}

function db(env) {
  // 与 packages/db 的 createDb 相同的选项；不调用 sql.end()（docs/07 §3）
  return postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: true })
}

async function upsert(sql, key, value) {
  await sql`
    insert into setting (id, key, value) values (gen_random_uuid(), ${key}, ${sql.json(value)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`
}

function modelStream(total, interval) {
  const chunks = Math.ceil((total * 1000) / interval)
  const encoder = new TextEncoder()
  let i = 0
  return {
    chunks,
    stream: new ReadableStream({
      async pull(controller) {
        if (i >= chunks) {
          controller.close()
          return
        }
        await new Promise((r) => setTimeout(r, interval))
        i += 1
        controller.enqueue(encoder.encode(`data: {"chunk":${i},"at":${Date.now()}}\n\n`))
      },
    }),
  }
}

async function drain(stream, sql, run, meta) {
  const startedAt = meta.startedAt
  const reader = stream.getReader()
  let chunks = 0
  let lastProgress = Date.now()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) break
      chunks += 1
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = Date.now()
        await upsert(sql, `${PREFIX}${run}.progress`, {
          ...meta,
          chunks,
          at: new Date(lastProgress).toISOString(),
          elapsedMs: lastProgress - startedAt,
        })
      }
    }
    const finishedAt = Date.now()
    await upsert(sql, `${PREFIX}${run}.done`, {
      ...meta,
      chunks,
      finishedAt: new Date(finishedAt).toISOString(),
      elapsedMs: finishedAt - startedAt,
    })
  } catch (e) {
    await upsert(sql, `${PREFIX}${run}.error`, { ...meta, chunks, error: String(e) })
  }
}

async function stream(url, env, ctx) {
  const run = url.searchParams.get('run') ?? ''
  const mode = url.searchParams.get('mode') ?? 'tee'
  const total = Number(url.searchParams.get('total') ?? '20')
  const interval = Number(url.searchParams.get('interval') ?? '500')
  if (!/^[a-z0-9-]{1,40}$/.test(run) || !['tee', 'nowait', 'detached'].includes(mode)) {
    return new Response('bad run or mode', { status: 400 })
  }
  if (!(total > 0 && total <= 600 && interval >= 50 && interval <= 5000)) {
    return new Response('bad total or interval', { status: 400 })
  }

  const sql = db(env)
  const { chunks: expected, stream: source } = modelStream(total, interval)
  const startedAt = Date.now()
  const meta = {
    run,
    mode,
    total,
    interval,
    expected,
    startedAt: new Date(startedAt).toISOString(),
  }
  // 先同步写 start，确保每次运行都有记录
  await upsert(sql, `${PREFIX}${run}.start`, meta)
  const drainMeta = { ...meta, startedAt }

  if (mode === 'detached') {
    ctx.waitUntil(drain(source, sql, run, drainMeta))
    return Response.json({ run, mode, expected })
  }

  const [toClient, toServer] = source.tee()
  const done = drain(toServer, sql, run, drainMeta)
  if (mode === 'tee') ctx.waitUntil(done)
  return new Response(toClient, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  })
}

async function results(env) {
  const sql = db(env)
  const rows = await sql`
    select key, value, updated_at from setting where starts_with(key, ${PREFIX}) order by key`
  return Response.json(rows)
}

async function cleanup(env) {
  const sql = db(env)
  const rows = await sql`delete from setting where starts_with(key, ${PREFIX}) returning key`
  return Response.json({ deleted: rows.length })
}
