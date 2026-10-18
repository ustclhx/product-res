import { BlockList, isIP } from 'node:net'
import { newRequestId, withLogContext } from '@product-res/shared/log'
import type { RequestMetadata } from '../index.ts'

function normalizeIp(value: string): string | null {
  const family = isIP(value)
  if (family === 4) return value
  if (family !== 6 || value.includes('%')) return null
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  // TCP peer 与 XFF 的 IPv4-mapped IPv6 必须落在同一防刷键上。
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1] as string, 16)
  const low = Number.parseInt(mapped[2] as string, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

/** 启动时编译可信 CIDR；默认空列表，只从 socket.remoteAddress 取得 peer。 */
export function createNodeRequestMetadata(trustedProxyCidrs: readonly string[] = []) {
  const trusted = new BlockList()
  for (const cidr of trustedProxyCidrs) {
    const parts = cidr.split('/')
    const address = parts[0] ?? ''
    const family = isIP(address)
    const prefix = Number(parts[1])
    if (
      parts.length !== 2 ||
      !family ||
      !/^\d+$/.test(parts[1] ?? '') ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    )
      throw new Error('Invalid trusted proxy CIDR')
    trusted.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  const isTrusted = (ip: string) => trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')
  return (request: Request, tcpPeer: string | undefined): RequestMetadata => {
    const peer = tcpPeer === undefined ? null : normalizeIp(tcpPeer)
    let clientIp = peer
    const forwarded = request.headers.get('x-forwarded-for')
    if (peer !== null && isTrusted(peer) && forwarded !== null) {
      const chain = forwarded.split(',').map((ip) => normalizeIp(ip.trim()))
      // 链上任一非法地址使整条链失效，避免攻击者操纵可信边界。
      if (chain.every((ip): ip is string => ip !== null)) {
        for (
          let index = chain.length - 1;
          index >= 0 && clientIp !== null && isTrusted(clientIp);
          index--
        )
          clientIp = chain[index] as string
      }
    }
    const cfRay = request.headers.get('cf-ray')
    return { clientIp, requestId: newRequestId(), ...(cfRay === null ? {} : { cfRay }) }
  }
}

/** 入口将同一 metadata 注入业务上下文；响应和日志共用生成的 requestId。 */
export async function withNodeRequestContext(
  metadata: RequestMetadata,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  return withLogContext({ requestId: metadata.requestId, cfRay: metadata.cfRay }, async () => {
    const response = await handler()
    const headers = new Headers(response.headers)
    headers.set('x-request-id', metadata.requestId)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
