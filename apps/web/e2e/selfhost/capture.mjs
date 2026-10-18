import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

// 只在 Compose 内部网络运行。邮件仅驻留内存，不写日志、磁盘或应用数据库。
const emails = []
const deliveries = new Map()

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://capture:8025')
    if (request.method === 'GET' && url.pathname === '/health') {
      respond(response, 200, { status: 'ok', deliveries: emails.length })
      return
    }
    if (request.method === 'GET' && url.pathname === '/emails') {
      const recipient = url.searchParams.get('to')
      respond(
        response,
        200,
        emails.filter((email) => recipient === null || email.to.includes(recipient)),
      )
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/emails') {
      respond(response, 404, { name: 'not_found' })
      return
    }
    const idempotencyKey = request.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      respond(response, 400, { name: 'missing_idempotency_key' })
      return
    }
    const chunks = []
    let byteLength = 0
    for await (const chunk of request) {
      byteLength += chunk.length
      if (byteLength > 1024 * 1024) {
        respond(response, 413, { name: 'payload_too_large' })
        return
      }
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const message = JSON.parse(body)
    if (
      !Array.isArray(message.to) ||
      !message.to.length ||
      !message.to.every((to) => typeof to === 'string') ||
      typeof message.from !== 'string' ||
      typeof message.subject !== 'string' ||
      typeof message.html !== 'string' ||
      typeof message.text !== 'string'
    ) {
      respond(response, 400, { name: 'validation_error' })
      return
    }
    const previous = deliveries.get(idempotencyKey)
    if (previous) {
      respond(
        response,
        previous.body === body ? 200 : 409,
        previous.body === body ? { id: previous.id } : { name: 'invalid_idempotent_request' },
      )
      return
    }
    const id = randomUUID()
    deliveries.set(idempotencyKey, { id, body })
    emails.push({ id, ...message })
    respond(response, 200, { id })
  } catch {
    // JSON 或请求异常不得回显正文、验证链接、凭据或驱动错误。
    respond(response, 400, { name: 'invalid_request' })
  }
})

server.listen(8025, '0.0.0.0')
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close())
}
