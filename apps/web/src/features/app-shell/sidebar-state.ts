import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { readCookie } from '../i18n/preference.ts'

// 侧边栏折叠状态存 cookie：服务端首屏按 cookie 直接渲染展开 / 收起，避免水合后闪动（tasks 8.3）。
export const SIDEBAR_COOKIE = 'app_sidebar'
const MAX_AGE = 365 * 86400

/** 未设置或取值未知时视为展开 */
export function parseSidebarOpen(cookie: string | null | undefined): boolean {
  return readCookie(cookie ?? '', SIDEBAR_COOKIE) !== 'collapsed'
}

export function sidebarCookie(open: boolean, secure = false): string {
  const value = open ? 'expanded' : 'collapsed'
  return `${SIDEBAR_COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function rememberSidebarOpen(open: boolean): void {
  // biome-ignore lint/suspicious/noDocumentCookie: 同步写入，下一次服务端渲染即按新状态输出。
  document.cookie = sidebarCookie(open, window.location.protocol === 'https:')
}

/** 首屏在服务端读请求 cookie，客户端导航读 document.cookie，两边结果一致且不额外请求 */
export const readSidebarOpen = createIsomorphicFn()
  .server(() => parseSidebarOpen(getRequest().headers.get('cookie')))
  .client(() => parseSidebarOpen(document.cookie))
