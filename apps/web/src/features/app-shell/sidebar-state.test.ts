import { describe, expect, it } from 'vitest'
import { parseSidebarOpen, SIDEBAR_COOKIE, sidebarCookie } from './sidebar-state.ts'

describe('侧边栏折叠 cookie', () => {
  it('未设置或取值未知时展开，collapsed 时收起', () => {
    expect(parseSidebarOpen(null)).toBe(true)
    expect(parseSidebarOpen('')).toBe(true)
    expect(parseSidebarOpen(`theme=dark; ${SIDEBAR_COOKIE}=collapsed`)).toBe(false)
    expect(parseSidebarOpen(`${SIDEBAR_COOKIE}=expanded`)).toBe(true)
    expect(parseSidebarOpen(`${SIDEBAR_COOKIE}=bogus`)).toBe(true)
  })

  it('写入的 cookie 能被读回，并按协议加 Secure', () => {
    const collapsed = sidebarCookie(false)
    expect(collapsed).toMatch(/^app_sidebar=collapsed; Path=\/; Max-Age=\d+; SameSite=Lax$/)
    expect(parseSidebarOpen(collapsed.split(';')[0])).toBe(false)
    expect(sidebarCookie(true, true)).toContain('; Secure')
  })
})
