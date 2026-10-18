/**
 * 7.2 实测用调用方（模拟 apps/web）：通过 script_name 绑定 probe-72-workflow 中的 Workflow，
 * 提供创建实例、查询状态、sendEvent 的 HTTP 接口，供 ../run.mjs 驱动。
 * 所有请求需带 `authorization: Bearer <PROBE_TOKEN>`（部署时用 --var 传入）。
 */
interface Env {
  PROBE_WF: Workflow
  PROBE_TOKEN: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 记录调用耗时与错误信息（错误也是实测结论的一部分，原样返回） */
async function attempt<T>(fn: () => Promise<T>) {
  const t = Date.now()
  try {
    return { ok: true as const, value: await fn(), ms: Date.now() - t, at: t }
  } catch (e) {
    const err = e as Error
    return { ok: false as const, error: `${err.name}: ${err.message}`, ms: Date.now() - t, at: t }
  }
}

interface EventBody {
  id: string
  type: string
  payload?: unknown
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.PROBE_TOKEN || req.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401)
    }
    const url = new URL(req.url)

    // 创建实例：body = { id?, params }
    if (req.method === 'POST' && url.pathname === '/create') {
      const body = (await req.json()) as { id?: string; params: unknown }
      const r = await attempt(async () => {
        const inst = await env.PROBE_WF.create({
          ...(body.id ? { id: body.id } : {}),
          params: body.params,
        })
        return { id: inst.id, status: await inst.status() }
      })
      return json(r)
    }

    // 在同一次调用中创建实例并立即 sendEvent（此时实例必然还没开始执行）
    // body = { params, events: [{ type, payload }] }
    if (req.method === 'POST' && url.pathname === '/create-and-send') {
      const body = (await req.json()) as {
        params: unknown
        events: Omit<EventBody, 'id'>[]
      }
      const created = await attempt(async () => {
        const inst = await env.PROBE_WF.create({ params: body.params })
        return inst
      })
      if (!created.ok) return json({ created })
      const inst = created.value
      const sends = []
      for (const ev of body.events) {
        sends.push({
          type: ev.type,
          ...(await attempt(() => inst.sendEvent({ type: ev.type, payload: ev.payload }))),
        })
      }
      const status = await attempt(() => inst.status())
      return json({ id: inst.id, createdAt: created.at, sends, statusAfterSend: status })
    }

    // 查询状态：?id=
    if (req.method === 'GET' && url.pathname === '/status') {
      const id = url.searchParams.get('id') ?? ''
      return json(await attempt(async () => (await env.PROBE_WF.get(id)).status()))
    }

    // 发送事件：body = { id, type, payload }；先 get 再 sendEvent，分别记录结果
    if (req.method === 'POST' && url.pathname === '/event') {
      const body = (await req.json()) as EventBody
      const got = await attempt(() => env.PROBE_WF.get(body.id))
      if (!got.ok) return json({ get: got })
      const inst = got.value
      const statusBefore = await attempt(() => inst.status())
      const send = await attempt(() => inst.sendEvent({ type: body.type, payload: body.payload }))
      return json({ statusBefore, send })
    }

    // 终止实例（清理用）：body = { id }
    if (req.method === 'POST' && url.pathname === '/terminate') {
      const body = (await req.json()) as { id: string }
      return json(await attempt(async () => (await env.PROBE_WF.get(body.id)).terminate()))
    }

    return json({ error: 'not found' }, 404)
  },
}
