import { AppError } from '@product-res/shared'
import { baseLocale, cookieName, isLocale, type Locale } from '../../paraglide/runtime.js'
import { paraglideMiddleware } from '../../paraglide/server.js'
import type { WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { languageUrl, localeCookie, readCookie, usesAccountLocale } from './preference.ts'
import { readRequestSession, withSessionCache } from './session.server.ts'

/** 中间件内用修改后的 Cookie 决定语言，交给路由器的仍是原地址与原请求头。 */
export function localizeRequest(
  request: Request,
  runtime: Pick<WebRuntime, 'db' | 'auth'>,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  // 单语言构建只使用 baseLocale，不读取账号或 Cookie，也不按 URL 自动跳转。
  if (!templateConfig.i18n.enabled) return paraglideMiddleware(request, next)
  const url = new URL(request.url)
  // 认证端点可能修改会话；不读取、不缓存会话，也不改 Cookie。
  if (url.pathname.startsWith('/api/')) return paraglideMiddleware(request, next)
  const run = request.method === 'GET' ? withSessionCache : <T>(handle: () => T) => handle()
  return run(async () => {
    const source = languageUrl(request)
    let locale: Locale | undefined
    if (usesAccountLocale(source)) {
      try {
        const fresh = await readRequestSession({
          auth: runtime.auth,
          db: runtime.db,
          headers: request.headers,
        })
        locale = isLocale(fresh.user.locale) ? fresh.user.locale : baseLocale
      } catch (error) {
        if (!(error instanceof AppError && [401, 403].includes(error.status))) throw error
      }
    }
    const headers = new Headers(request.headers)
    if (locale) {
      const cookies = (headers.get('cookie') ?? '')
        .split(';')
        .filter((part) => !part.trim().startsWith(`${cookieName}=`))
      headers.set('cookie', [...cookies, `${cookieName}=${locale}`].join('; '))
    }
    // 此 Request 仅供语言识别；请求体只交给 next 内的原始请求消费。
    const localized = new Request(request.url, { headers, method: request.method })
    const response = await paraglideMiddleware(localized, next, { effectiveRequestUrl: source })
    if (locale) {
      // 账号语言同步给客户端水合；应用区响应不可被共享缓存。
      const result = new Response(response.body, response)
      result.headers.set('cache-control', 'private, no-store')
      if (readCookie(request.headers.get('cookie') ?? '', cookieName) !== locale)
        result.headers.append('set-cookie', localeCookie(locale, url.protocol === 'https:'))
      return result
    }
    return response
  })
}
