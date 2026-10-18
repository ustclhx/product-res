import { templateConfig } from '../../server/template-config.ts'
import { NOT_FOUND_PATH } from '../admin/gate.ts'
import { isAppAreaPath } from './app-area.ts'

/**
 * Worker 入口中的语言守卫（tasks.md 1.1）：应用区不加语言前缀，带前缀访问（`/<locale>/app` 等）
 * 改写到不存在的路径，由应用渲染普通的 404 页面；其余请求原样返回。
 * 只在服务端使用（引用了 admin 守卫），路由器的 URL 改写见 routing.ts。
 */
export function gateLocaleRequest(request: Request): Request {
  const url = new URL(request.url)
  const [, first, ...rest] = url.pathname.split('/')
  const prefixed = templateConfig.i18n.locales.some((locale) => locale === first)
  if (!prefixed || (templateConfig.i18n.enabled && !isAppAreaPath(`/${rest.join('/')}`)))
    return request
  return new Request(new URL(NOT_FOUND_PATH, url), request)
}
