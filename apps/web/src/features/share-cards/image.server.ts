import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { createShareCardImageStore } from '@product-res/storage'
import { getWebRuntime } from '../../server/runtime.ts'
import { isShareRevoked, precheckShare, remainingSeconds, resolveShare } from './lookup.ts'
// meta.server.ts 引入 index.ts，加载时登记项目类型。
import { shareLookupDeps } from './meta.server.ts'
import { shareCardImagePath, shareCardVariant } from './meta.ts'
import { renderShareCard } from './render.server.ts'
import { SHARE_CARD_BUSY } from './renderer.ts'
import { resolveRequestShareCardSite } from './site.ts'
import { resolveShareCardTheme } from './theme.ts'

/**
 * 浏览器与公共缓存上限都是 1 天，且不超过剩余有效期（design 第 3 条）：与 KV 撤销标记的 1 天 TTL 一致，
 * 标记过期时边缘缓存条目也已过期，撤销后的旧图不会再从 Cache API 返回。撤销无法清除 `immutable`，不使用。
 */
export const SHARE_CARD_MAX_AGE = 86_400
/** Cache API 条目记录到期时间（ISO 或 `never`），命中时据此重算缓存头；不发给客户端。 */
export const SHARE_CARD_EXPIRES_HEADER = 'x-share-card-expires'
/** `v` 只能是 base64url 字符；不符合时不读缓存与存储，由解析结果决定 302 或 404。 */
const VARIANT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** 渲染并发超限时建议的重试间隔（秒）。 */
const BUSY_RETRY_AFTER = 5

export function shareCardImageHeaders(expiresAt: Date | null, now = new Date()) {
  const seconds = Math.min(SHARE_CARD_MAX_AGE, remainingSeconds(expiresAt, now))
  return {
    'content-type': 'image/png',
    'cache-control': `public, max-age=${seconds}, s-maxage=${seconds}`,
    'x-robots-tag': 'noindex',
    'x-content-type-options': 'nosniff',
  }
}

/** 404 / 429 / 503 / 500 不进入公共缓存，正文不含资源信息或错误详情。 */
function failure(status: 404 | 429 | 500 | 503, headers: Record<string, string> = {}) {
  const text = { 404: 'Not Found', 429: 'Too Many Requests', 500: 'Error', 503: 'Busy' }[status]
  return new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function png(body: Uint8Array, expiresAt: Date | null, now: Date) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: shareCardImageHeaders(expiresAt, now),
  })
}

/** 写入 Cache API 的副本附带到期时间，命中时重算缓存头。 */
function forEdge(response: Response, expiresAt: Date | null) {
  const copy = response.clone()
  const headers = new Headers(copy.headers)
  headers.set(SHARE_CARD_EXPIRES_HEADER, expiresAt === null ? 'never' : expiresAt.toISOString())
  return new Response(copy.body, { status: 200, headers })
}

/** Cache API 命中：按记录的到期时间重算缓存头；记录缺失、无法解析或已到期时视为未命中。 */
async function fromEdge(cached: Response, now: Date): Promise<Response | null> {
  const raw = cached.headers.get(SHARE_CARD_EXPIRES_HEADER)
  const expiresAt = raw === 'never' ? null : new Date(raw ?? '')
  if (raw === null || (expiresAt !== null && remainingSeconds(expiresAt, now) < 1)) {
    // 不等待取消完成：clone 出的分支要等另一支也取消才会兑现。
    cached.body?.cancel().catch(() => {})
    return null
  }
  return png(new Uint8Array(await cached.arrayBuffer()), expiresAt, now)
}

/**
 * `GET /share-card/<type>/<token>.png?v=<version>-<digest8>`（design 第 3、9 条）：
 * 令牌格式（含长度上限）→ KV 撤销标记 → Cache API（自托管跳过）→ 对象存储图片（元数据到期则删除并 404）
 * → 限流 → resolve → 到期 → 摘要比对（不一致 302 到当前地址）→ 渲染 → 再查撤销标记 → 写对象存储
 * 图片与空间索引、Cache API。缓存命中时不调用项目解析，不查库。
 */
export async function handleShareCardImageRequest(
  request: Request,
  params: { type?: string | undefined; file?: string | undefined },
): Promise<Response> {
  const type = params.type ?? ''
  const file = params.file ?? ''
  if (!file.endsWith('.png')) return failure(404)
  const token = file.slice(0, -'.png'.length)
  const runtime = getWebRuntime()
  const deps = shareLookupDeps()
  const checked = await precheckShare(deps, { type, token, page: false })
  if (checked.status !== 'ok') return failure(404)

  const url = new URL(request.url)
  const variant = url.searchParams.get('v') ?? ''
  // 缓存键只保留 v，其余查询参数不能制造新的缓存条目；语言 `l` 已计入 v。
  const cacheKey = `${url.origin}${url.pathname}?v=${encodeURIComponent(variant)}`
  const edge = runtime.shareCardCache?.available ? runtime.shareCardCache.value : undefined
  const objects = runtime.files?.available ? runtime.files.value.shareCards : undefined
  const images = objects ? createShareCardImageStore(objects) : undefined

  if (VARIANT_PATTERN.test(variant)) {
    const now = new Date()
    const cached = await edge?.match(cacheKey)
    const hit = cached ? await fromEdge(cached, now) : null
    if (hit) return hit
    if (images) {
      let stored: Awaited<ReturnType<typeof images.read>> = { status: 'miss' }
      try {
        stored = await images.read({ type, token, variant }, now)
      } catch (error) {
        // 读取失败按未命中处理，继续解析与渲染。
        log.warn('share-cards.read-failed', { type, error })
      }
      if (stored.status === 'expired') return failure(404)
      if (stored.status === 'hit' && remainingSeconds(stored.expiresAt, now) >= 1) {
        const response = png(stored.body, stored.expiresAt, now)
        await edge?.put(cacheKey, forEdge(response, stored.expiresAt))
        return response
      }
    }
  }

  let result: Awaited<ReturnType<typeof resolveShare>>
  try {
    result = await resolveShare(deps, checked)
  } catch (error) {
    // 项目 resolve 或限流抛错：不带错误详情，也不进入缓存。
    log.error('share-cards.resolve-failed', { type, error })
    return failure(500)
  }
  if (result.status === 'rate-limited') return failure(429, { 'retry-after': '60' })
  if (result.status !== 'ok') return failure(404)
  const { card, resolution, expiresAt } = result
  // 站点按本次请求的 host 与地址中的语言 `l` 解析，与分享页元数据一致；站点覆盖与非默认语言进入 v，
  // 不同站点、不同语言不共用缓存。`l` 只接受模板配置的语言，其余按默认语言处理（v 不符时 302）。
  const { site, themeOverride } = resolveRequestShareCardSite(
    request.url,
    runtime.config.APP_URL,
    undefined,
    url.searchParams.get('l'),
  )
  const expected = shareCardVariant(card, resolution.data, site)
  if (variant !== expected)
    return new Response(null, {
      status: 302,
      headers: {
        location: shareCardImagePath(card, token, resolution.data, site),
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    })

  let body: Uint8Array
  try {
    body = await renderShareCard(
      card,
      resolution.data,
      resolveShareCardTheme('light', themeOverride),
      site,
    )
  } catch (error) {
    if (error instanceof AppError && error.code === SHARE_CARD_BUSY)
      return failure(503, { 'retry-after': String(BUSY_RETRY_AFTER) })
    log.error('share-cards.render-failed', { type, error })
    return failure(500)
  }

  // 渲染期间项目可能已撤销：写入前后各查一次强一致的 R2 墓碑（KV 读取默认缓存 60 秒，看不到刚写的标记）。
  // 未装配对象存储时没有写入，退回 KV 标记。
  const revoked = () => (images ? images.isRevoked(type, token) : isShareRevoked(deps, type, token))
  if (await revoked()) return failure(404)
  const now = new Date()
  if (remainingSeconds(expiresAt, now) < 1) return failure(404)
  if (images) {
    const ref = { type, token, variant, workspaceId: resolution.workspaceId }
    try {
      await images.write(ref, body, expiresAt)
    } catch (error) {
      // 持久存储失败不影响本次返回；下次未命中时重新渲染。
      log.warn('share-cards.store-failed', { type, error })
    }
    // 写入与失效并发时（失效先列出前缀、本次后写入），撤回本次写入。
    if (await revoked()) {
      await images.discard(ref).catch((error: unknown) => {
        // 撤回失败时空间索引仍在，删空间清理可以重试。
        log.warn('share-cards.discard-failed', { type, error })
      })
      return failure(404)
    }
  }
  const response = png(body, expiresAt, now)
  await edge?.put(cacheKey, forEdge(response, expiresAt))
  return response
}
