import { beforeEach, describe, expect, it, vi } from 'vitest'

const marketing = vi.hoisted(() => ({ enabled: true }))
const publicPaths = [
  '/pricing',
  '/blog/',
  '/blog/$slug',
  '/docs/',
  '/legal/$slug',
  '/newsletter',
  '/waitlist',
  '/api/newsletter/',
  '/api/newsletter/confirm',
  '/api/waitlist/',
  '/sitemap.xml',
  '/robots.txt',
]

vi.mock('../../server/template-config.ts', async (original) => {
  const actual = await original<typeof import('../../server/template-config.ts')>()
  return { ...actual, templateConfig: { ...actual.templateConfig, marketing } }
})

// 使用真实 Router 验证注册结果，隔离生成树中与入口裁剪无关的数据库和页面依赖。
function mockRouteTree() {
  vi.doMock('../../routeTree.gen', async () => {
    const { createRootRoute, createRoute } = await import('@tanstack/react-router')
    const root = createRootRoute()
    const paths = [
      '/',
      '/app',
      '/account',
      '/admin',
      '/api/auth/$',
      '/api/health',
      '/pricing',
      '/blog/',
      '/blog/$slug',
      '/docs/',
      '/legal/$slug',
      '/newsletter',
      '/waitlist',
      '/api/newsletter/',
      '/api/newsletter/confirm',
      '/api/waitlist/',
      '/sitemap.xml',
      '/robots.txt',
    ]
    return {
      routeTree: root.addChildren(
        paths.map((path) => createRoute({ getParentRoute: () => root, path })),
      ),
    }
  })
}

beforeEach(() => {
  marketing.enabled = true
  vi.resetModules()
  mockRouteTree()
})

describe('营销入口注册', () => {
  it('启用时注册营销页面、订阅接口与 SEO 端点', async () => {
    const { getRouter } = await import('../../router.tsx')
    const paths = Object.keys(getRouter().routesByPath)
    for (const path of publicPaths) expect(paths).toContain(path.replace(/\/$/, ''))
  })

  it('关闭时移除营销入口，保留首页、应用与认证入口', async () => {
    marketing.enabled = false
    const { getRouter } = await import('../../router.tsx')
    const paths = Object.keys(getRouter().routesByPath)
    for (const path of publicPaths) expect(paths).not.toContain(path.replace(/\/$/, ''))
    for (const path of ['/', '/app', '/account', '/admin', '/api/auth/$', '/api/health']) {
      expect(paths).toContain(path)
    }
  })
})
