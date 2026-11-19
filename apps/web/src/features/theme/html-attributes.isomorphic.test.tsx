import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseLocale } from '../../paraglide/runtime.js'
import { Route } from '../../routes/__root.tsx'
import { getHtmlAttributes } from './html-attributes.isomorphic.ts'
import { getProjectHtmlAttributes } from './html-attributes.ts'
import { RootDocument } from './root-document.tsx'

const runtime = vi.hoisted(() => ({ client: false }))

// 单元测试没有 Start 编译转换，在同一测试内选择同构函数的真实实现。
vi.mock('@tanstack/react-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start')>()),
  createIsomorphicFn: () => ({
    server: (server: (pathname: string) => Record<string, string>) => ({
      client: (client: (pathname: string) => Record<string, string>) => (pathname: string) =>
        runtime.client ? client(pathname) : server(pathname),
    }),
  }),
}))
vi.mock('@tanstack/react-start/server', () => ({ getRequest: vi.fn() }))
vi.mock('./html-attributes.ts', () => ({ getProjectHtmlAttributes: vi.fn(() => ({})) }))
vi.mock('../seo/origin.functions.ts', () => ({
  getSafeImpersonation: vi.fn(),
  getSeoOrigin: vi.fn(),
  getPlausibleSite: vi.fn(),
}))
vi.mock('../admin/settings-announcement.functions.ts', () => ({ getAnnouncement: vi.fn() }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  HeadContent: () => null,
  Scripts: () => null,
}))

afterEach(() => {
  runtime.client = false
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('根文档属性同构入口', () => {
  it('服务端从请求计算项目属性并保留在 SSR 文档中', () => {
    vi.mocked(getRequest).mockReturnValue(new Request('https://east.example.com:8443/zh/pricing'))
    vi.mocked(getProjectHtmlAttributes).mockReturnValue({ 'data-site': 'east', dir: 'ltr' })

    const attributes = getHtmlAttributes('/pricing')
    expect(getProjectHtmlAttributes).toHaveBeenCalledWith({
      host: 'east.example.com:8443',
      // 无请求上下文时 getLocale 回落到默认语言，衍生项目可能为 zh
      locale: baseLocale,
      pathname: '/pricing',
    })
    const html = renderToString(
      <RootDocument floatingControls={false} htmlAttributes={attributes}>
        <main>content</main>
      </RootDocument>,
    )
    expect(html).toContain('data-site="east"')
    expect(html).toContain('dir="ltr"')
  })

  it('客户端导航复用现有白名单属性，不调用服务端或发起请求', async () => {
    runtime.client = true
    const fetch = vi.fn(() => {
      throw new Error('客户端根文档属性不应发起请求')
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { location: { origin: 'https://east.example.com' } })
    vi.stubGlobal('self', {})
    vi.stubGlobal('document', {
      documentElement: {
        attributes: Object.entries({
          'data-site': 'east',
          title: 'Project',
          dir: 'rtl',
          translate: 'no',
          lang: 'zh',
          'data-preset': 'violet',
          class: 'dark',
          onclick: 'unsafe',
          style: 'unsafe',
          'data-bad_': 'unsafe',
        }).map(([name, value]) => ({ name, value })),
      },
    })

    const beforeLoad = Route.options.beforeLoad
    if (typeof beforeLoad !== 'function') throw new Error('Root beforeLoad is missing')
    const rootRoute = createRootRoute({ beforeLoad })
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/pricing' }),
    ])
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
      isServer: false,
    })
    const attributes = { 'data-site': 'east', title: 'Project', dir: 'rtl', translate: 'no' }
    await router.load()
    expect(router.state.matches[0]?.context.htmlAttributes).toEqual(attributes)
    await router.navigate({ to: '/pricing' })
    expect(router.state.location.pathname).toBe('/pricing')
    expect(router.state.matches[0]?.context.htmlAttributes).toEqual(attributes)
    expect(getRequest).not.toHaveBeenCalled()
    expect(getProjectHtmlAttributes).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
