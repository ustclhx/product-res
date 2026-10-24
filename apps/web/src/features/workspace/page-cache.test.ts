import { describe, expect, it, vi } from 'vitest'
import { createWorkspacePageCache, WORKSPACE_PAGE_TTL_MS } from './page-cache.ts'

type Page = { activation: 'active' | 'pending'; n: number }

function setup(enabled = true) {
  let clock = 1_000
  const cache = createWorkspacePageCache<Page>({
    cacheable: (page) => page.activation === 'active',
    enabled: () => enabled,
    now: () => clock,
  })
  let n = 0
  const fetchPage = vi.fn(async (activation: Page['activation'] = 'active') => ({
    activation,
    n: ++n,
  }))
  return { cache, fetchPage, advance: (ms: number) => (clock += ms) }
}

describe('工作空间页客户端缓存', () => {
  it('TTL 内同一 slug 命中缓存，过期后重新获取', async () => {
    const { cache, fetchPage, advance } = setup()
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 1 })
    advance(WORKSPACE_PAGE_TTL_MS - 1)
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 1 })
    advance(1)
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 2 })
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('进行中的请求被并发调用共用（预加载与导航只发一次）', async () => {
    const { cache, fetchPage } = setup()
    const [first, second] = await Promise.all([
      cache.load('a', () => fetchPage()),
      cache.load('a', () => fetchPage()),
    ])
    expect(first).toBe(second)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('待开通结果不缓存：管理员开通后下一次导航即取到新状态', async () => {
    const { cache, fetchPage } = setup()
    expect(await cache.load('a', () => fetchPage('pending'))).toMatchObject({
      activation: 'pending',
    })
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ activation: 'active', n: 2 })
  })

  it('失败不缓存', async () => {
    const { cache, fetchPage } = setup()
    await expect(cache.load('a', () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 1 })
  })

  it('切换空间、fresh 与 clear 都会重新获取', async () => {
    const { cache, fetchPage } = setup()
    await cache.load('a', () => fetchPage())
    expect(await cache.load('b', () => fetchPage())).toMatchObject({ n: 2 })
    // 只保留当前空间：切回 a 重新获取
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 3 })
    expect(await cache.load('a', () => fetchPage(), { fresh: true })).toMatchObject({ n: 4 })
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 4 })
    cache.clear()
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 5 })
  })

  it('prime 用 SSR 数据填充，但不覆盖已有条目、不延长 TTL、不收待开通结果', async () => {
    const { cache, fetchPage, advance } = setup()
    cache.prime('a', { activation: 'pending', n: 100 })
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 1 })
    advance(WORKSPACE_PAGE_TTL_MS - 1)
    cache.prime('a', { activation: 'active', n: 200 })
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 1 })
    advance(1)
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 2 })
    cache.clear()
    cache.prime('a', { activation: 'active', n: 300 })
    expect(await cache.load('a', () => fetchPage())).toMatchObject({ n: 300 })
  })

  it('服务端（未启用）每次都获取，不跨请求共享', async () => {
    const { cache, fetchPage } = setup(false)
    cache.prime('a', { activation: 'active', n: 100 })
    await cache.load('a', () => fetchPage())
    await cache.load('a', () => fetchPage())
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })
})
