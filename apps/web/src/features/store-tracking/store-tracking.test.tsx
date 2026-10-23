import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { type StoreDetailData, StoreDetailPage } from './store-detail-page.tsx'
import type { StoreRowView } from './store-tracking.server.ts'
import { type StoresData, StoresPage } from './stores-page.tsx'

// 页面里的 Link 只需渲染为普通链接
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    hash,
  }: {
    children: unknown
    to: string
    params?: object
    hash?: string
  }) => <a href={`${to}#${hash ?? JSON.stringify(params ?? {})}`}>{children as never}</a>,
}))

const amazon: StoreRowView = {
  id: '0190a000-0000-7000-8000-000000000001',
  platform: 'amazon',
  marketplace: 'amazon-us',
  sellerKey: 'A1B2C3',
  displayName: 'Rack House',
  url: 'https://www.amazon.com/sp?seller=A1B2C3',
  kind: 'benchmark',
  status: 'active',
  reason: null,
  directionIds: [],
  directionNames: [],
  keywords: ['spice rack'],
  searchKeywords: ['spice rack'],
  new7d: 2,
  new30d: 3,
  pending: 1,
  hitRate: null,
  lastSyncAt: null,
  source: 'ok',
  createdAt: '2031-06-01T00:00:00.000Z',
}
const ebay: StoreRowView = {
  ...amazon,
  id: '0190a000-0000-7000-8000-000000000002',
  platform: 'ebay',
  marketplace: 'ebay-us',
  sellerKey: 'kitchen_pro',
  displayName: 'kitchen_pro',
  kind: 'watch',
  status: 'paused',
  pending: 0,
  hitRate: 0.25,
  source: 'not-configured',
}

const list: StoresData = {
  day: '2031-06-20',
  stores: [amazon, ebay],
  removedCount: 1,
  directions: [],
  sources: { dataforseo: 'ok', 'ebay-browse': 'not-configured', serpapi: 'not-configured' },
  disabledSources: [],
  canWrite: true,
  roundAvailable: true,
}

describe('店铺追踪列表', () => {
  it('列出店铺、新品数与命中率；eBay 来源未配置时提示 Amazon 照常追踪', () => {
    const html = renderToStaticMarkup(<StoresPage slug="s" initial={list} />)
    expect(html).toContain('店铺追踪')
    expect(html).toContain('Rack House')
    expect(html).toContain('2 / 3')
    expect(html).toContain('1 个待确认')
    expect(html).toContain('25%')
    expect(html).toContain('eBay 来源未配置：eBay 店铺暂不发现新品，Amazon 店铺照常追踪。')
    expect(html).toContain('来源未配置')
    expect(html).toContain('另有 1 个已移除的店铺')
    // 写权限：添加表单与“立即跑一轮”
    expect(html).toContain('加入店铺池')
    expect(html).toContain('立即跑一轮')
    // 暂停的店铺显示“恢复”
    expect(html).toContain('恢复')
  })

  it('只读成员看不到写操作', () => {
    const html = renderToStaticMarkup(
      <StoresPage slug="s" initial={{ ...list, canWrite: false }} />,
    )
    expect(html).not.toContain('加入店铺池')
    expect(html).not.toContain('立即跑一轮')
    expect(html).toContain('你可以查看店铺池')
  })

  it('所需数据源停用时页面顶部醒目提示并链接到数据中心对应来源', () => {
    const html = renderToStaticMarkup(
      <StoresPage
        slug="s"
        initial={{
          ...list,
          disabledSources: [
            { id: 'ebay-browse', label: 'eBay Browse', platform: 'ebay', role: 'discovery' },
            { id: 'serpapi', label: 'SerpApi', platform: 'amazon', role: 'cross' },
          ],
        }}
      />,
    )
    expect(html).toContain('数据源 eBay Browse 已停用，eBay 店铺不会采集。')
    expect(html).toContain('数据源 SerpApi 已停用，Amazon 热点商品不会做交叉验证采集。')
    expect(html).toContain('href="/app/$slug/data#source-ebay-browse"')
    expect(html).toContain('href="/app/$slug/data#source-serpapi"')
    expect(html).toContain('data-testid="store-source-disabled"')
  })

  it('/str/ 链接的解析预览说明会确认卖家用户名', () => {
    expect(m.store_tracking_parsed_store_name({ storeName: 'watchgenies' })).toContain(
      'ebay.com/usr/<用户名>',
    )
  })

  it('空店铺池', () => {
    const html = renderToStaticMarkup(<StoresPage slug="s" initial={{ ...list, stores: [] }} />)
    expect(html).toContain('店铺池还是空的')
  })
})

const detail: StoreDetailData = {
  day: '2031-06-20',
  store: amazon,
  listings: [
    {
      productId: 'p1',
      platformId: 'B0TEST0001',
      title: 'Spice Rack',
      url: 'https://www.amazon.com/dp/B0TEST0001',
      imageUrl: null,
      firstSeenOn: '2031-06-12',
      lastSeenOn: '2031-06-19',
      delistedOn: null,
      listedOn: '2031-06-10',
      isNew: true,
      discovery: 'search-offer',
      tier: 'hot',
      tierReason: 'sale-signal',
      signal: { on: '2031-06-20', kind: 'amazon-bought', low: 50, high: 100 },
      sales: { low: 50, high: 100 },
    },
    {
      productId: 'p2',
      platformId: 'B0TEST0002',
      title: null,
      url: null,
      imageUrl: null,
      firstSeenOn: '2031-06-19',
      lastSeenOn: '2031-06-19',
      delistedOn: '2031-06-20',
      listedOn: null,
      isNew: null,
      discovery: 'search-offer',
      tier: null,
      tierReason: null,
      signal: null,
      sales: { low: 10_000, high: null },
    },
  ],
  metrics: {
    newPerWeek: null,
    survivalRate: null,
    hitRate: null,
    salesSum: null,
    directionShift: null,
    sample: 1,
  },
  coverage: { method: 'search-offer', found30d: 2 },
  directions: [],
  disabledSources: [],
  canWrite: false,
}

describe('店铺详情', () => {
  it('Amazon 店铺标注“关键词覆盖，不完整”与搜索词、30 天发现数', () => {
    const html = renderToStaticMarkup(<StoreDetailPage slug="s" initial={detail} />)
    expect(html).toContain('发现方式：关键词覆盖，不完整')
    expect(html).toContain('搜索词：spice rack')
    expect(html).toContain('最近 30 天发现 2 个商品')
  })

  it('样本不足时店铺指标为空，不显示 0%', () => {
    const html = renderToStaticMarkup(<StoreDetailPage slug="s" initial={detail} />)
    expect(html).toContain('样本不足')
    expect(html).not.toContain('0%')
    expect(html).toContain('样本：1 个店铺新品')
  })

  it('新品列表显示档位与原因、出单信号与区间、上架待确认与下架', () => {
    const html = renderToStaticMarkup(<StoreDetailPage slug="s" initial={detail} />)
    expect(html).toContain('热点')
    expect(html).toContain('出现出单信号')
    expect(html).toContain('进入 bought 区间 50–100')
    expect(html).toContain('10K+')
    expect(html).toContain('待确认')
    expect(html).toContain('2031-06-20 下架')
    expect(html).toContain('未追踪')
  })

  it('eBay 店铺：官方 Browse 发现；来源未配置时提示', () => {
    const html = renderToStaticMarkup(
      <StoreDetailPage
        slug="s"
        initial={{
          ...detail,
          store: ebay,
          coverage: { method: 'browse-seller', found30d: 0 },
          listings: [],
        }}
      />,
    )
    expect(html).toContain('eBay Browse 官方接口')
    expect(html).toContain('eBay 来源未配置')
    expect(html).toContain('还没有发现该店铺的商品')
  })

  it('详情页：店铺所需来源停用时顶部提示', () => {
    const html = renderToStaticMarkup(
      <StoreDetailPage
        slug="s"
        initial={{
          ...detail,
          disabledSources: [
            { id: 'dataforseo', label: 'DataForSEO', platform: 'amazon', role: 'discovery' },
          ],
        }}
      />,
    )
    expect(html).toContain('数据源 DataForSEO 已停用，Amazon 店铺不会采集。')
    expect(html).toContain('前往数据中心启用')
  })
})
