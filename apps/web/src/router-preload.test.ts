import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 已安装 @tanstack/router-core 的预加载复用语义（docs/frontend-navigation.md）：
// 工作台子路由都是 staleTime: 0，验证悬停预加载的数据在导航时被复用，以及失效与过期的行为。
const PRELOAD_STALE_MS = 10_000

function setup() {
  const calls = { parent: 0, list: 0, other: 0 }
  const rootRoute = createRootRoute()
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/$slug',
    beforeLoad: () => {
      calls.parent += 1
      return {}
    },
  })
  const list = createRoute({
    getParentRoute: () => workspace,
    path: '/list',
    loader: () => ++calls.list,
    staleTime: 0,
  })
  const other = createRoute({
    getParentRoute: () => workspace,
    path: '/other',
    loader: () => ++calls.other,
    staleTime: 0,
  })
  // 应用的 Register 声明绑定了真实路由树，这里用独立路由树，按 AnyRouter 处理
  const router: AnyRouter = createRouter({
    routeTree: rootRoute.addChildren([workspace.addChildren([list, other])]),
    history: createMemoryHistory({ initialEntries: ['/app/s/other'] }),
    isServer: false,
    origin: 'http://localhost',
    defaultPreload: 'intent',
    defaultPreloadStaleTime: PRELOAD_STALE_MS,
  })
  return { router, calls }
}

const listData = (router: AnyRouter) =>
  (router.state.matches as Array<{ routeId: string; loaderData?: unknown }>).find(
    (match) => match.routeId === '/app/$slug/list',
  )?.loaderData
// 导航选项按应用注册的路由树做类型检查，独立路由树的路径在这里放宽
const toList = { to: '/app/s/list' } as never

afterEach(() => {
  vi.useRealTimers()
})

describe('TanStack Router 预加载复用', () => {
  it('preloadStaleTime 内导航复用预加载的 loader 数据，即使路由 staleTime 为 0', async () => {
    const { router, calls } = setup()
    await router.load()
    await router.preloadRoute(toList)
    expect(calls.list).toBe(1)
    await router.navigate(toList)
    expect(calls.list).toBe(1)
    expect(listData(router)).toBe(1)
    // beforeLoad 不在复用范围内：预加载与导航各跑一次，所以 /app/$slug 需要自己的缓存
    expect(calls.parent).toBe(3)
  })

  it('超过 preloadStaleTime 后导航重新调用 loader', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { router, calls } = setup()
    await router.load()
    await router.preloadRoute(toList)
    vi.setSystemTime(Date.now() + PRELOAD_STALE_MS + 1)
    await router.navigate(toList)
    await vi.waitFor(() => expect(calls.list).toBe(2))
  })

  it('router.invalidate() 使预加载结果失效，写操作后导航拿到新数据', async () => {
    const { router, calls } = setup()
    await router.load()
    await router.preloadRoute(toList)
    await router.invalidate()
    await router.navigate(toList)
    // 失效的已有数据按 stale-while-revalidate：先渲染旧数据，后台重新调用 loader 后替换
    await vi.waitFor(() => expect(listData(router)).toBe(2))
    expect(calls.list).toBe(2)
  })

  it('当前页 router.invalidate() 重新调用 loader', async () => {
    const { router, calls } = setup()
    await router.navigate(toList)
    expect(calls.list).toBe(1)
    await router.invalidate()
    await vi.waitFor(() => expect(listData(router)).toBe(2))
  })
})
