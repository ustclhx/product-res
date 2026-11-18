import { getRequest } from '@tanstack/react-start/server'
import { getLocale } from '../../paraglide/runtime.js'
import { getWebRuntime } from '../../server/runtime.ts'
import { absoluteUrl } from '../seo/metadata.ts'
import { lookupShare, remainingSeconds, type ShareLookup } from './lookup.ts'
import { shareLookupDeps } from './meta.server.ts'
import { buildShareCardMeta } from './meta.ts'
import { type SharePageView, sharePageView } from './page.ts'
import { resolveRequestShareCardSite } from './site.ts'

/** 文档请求在渲染前已查找过的结果；SSR 内调用的 server function 复用它，避免重复消耗限流配额。 */
const documentLookups = new WeakMap<Request, ShareLookup>()

/** 分享页边缘缓存上限 5 分钟；有效分享不超过剩余有效期，到期后边缘不再返回旧页面。 */
export const SHARE_PAGE_MAX_AGE = 300

export function sharePageHeaders(result: ShareLookup, now = new Date()) {
  const seconds =
    result.status === 'ok'
      ? Math.min(SHARE_PAGE_MAX_AGE, remainingSeconds(result.expiresAt, now))
      : SHARE_PAGE_MAX_AGE
  return { 'cache-control': `public, s-maxage=${seconds}`, 'x-robots-tag': 'noindex' }
}

/**
 * `/s/$type/$token` 文档请求的服务端入口（design 第 8、9 条）：渲染前完成撤销、格式、限流、
 * 解析与到期检查。限流直接返回 429（页面渲染只能给出 200 / 404 / 500）；其余结果交给页面渲染，
 * 再统一加上边缘缓存（最多 5 分钟且不超过剩余有效期）与 noindex。每次访问都会调用项目的 resolve（会查库），访问来自
 * 真实访客与平台抓取器；撤销最迟 5 分钟后生效，失效函数写入的 KV 标记先于 resolve 检查。
 */
export async function handleSharePageRequest<N>({
  request,
  params,
  next,
}: {
  request: Request
  params: { type?: string; token?: string }
  next: () => N | Promise<N>
}): Promise<Awaited<N> | Response> {
  const result = await lookupShare(shareLookupDeps(), {
    type: params.type ?? '',
    token: params.token ?? '',
    page: true,
  })
  if (result.status === 'rate-limited')
    return new Response('Too many requests. Please try again in a minute.\n', {
      status: 429,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '60',
        'x-robots-tag': 'noindex',
      },
    })
  documentLookups.set(request, result)
  const ctx = await next()
  // 渲染结果的响应头可写；404 也带同样的缓存与 noindex。
  const response = (ctx as { response?: Response } | undefined)?.response
  for (const [name, value] of Object.entries(sharePageHeaders(result)))
    response?.headers.set(name, value)
  return ctx
}

/** 页面数据：文档请求复用渲染前的结果，客户端路由跳转（server function 请求）时自行查找。 */
export async function loadSharePage(input: {
  type: string
  token: string
}): Promise<SharePageView> {
  const request = getRequest()
  const result =
    documentLookups.get(request) ?? (await lookupShare(shareLookupDeps(), { ...input, page: true }))
  if (result.status !== 'ok') return { status: result.status }
  // 页面语言随卡片地址的 `l` 传给卡片路由，多语言站点的卡片与页面使用同一品牌。
  const { site, origin } = resolveRequestShareCardSite(
    request.url,
    getWebRuntime().config.APP_URL,
    undefined,
    getLocale(),
  )
  const path = `/s/${encodeURIComponent(input.type)}/${encodeURIComponent(input.token)}`
  return sharePageView(
    result,
    buildShareCardMeta({
      card: result.card,
      token: result.token,
      data: result.resolution.data,
      appUrl: origin,
      pageUrl: absoluteUrl(origin, path),
      siteName: site.brand.name,
      site,
    }),
  )
}
