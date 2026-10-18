import { describe, expect, it } from 'vitest'
import {
  assignClusters,
  type ClusterProduct,
  crossMarketplaceLinks,
  jaccard,
  mergeClusters,
  normalizeTitle,
  productKey,
  splitMember,
} from '../src/index.ts'

function ids() {
  let n = 0
  return () => {
    n += 1
    return `c${n}`
  }
}

const p = (platformId: string, extra: Partial<ClusterProduct> = {}): ClusterProduct => ({
  marketplace: 'ebay-us',
  platformId,
  ...extra,
})

describe('标题规范化与 Jaccard', () => {
  it('小写、去品牌词与停用词、去数量单位', () => {
    expect(
      normalizeTitle('OXO Good Grips 3-Pack 16oz Storage Containers, Set of 3', ['OXO Good Grips']),
    ).toEqual(['containers', 'storage'])
    expect(normalizeTitle('Café  CRÈME 2x 10 inch Mug')).toEqual(['cafe', 'creme', 'mug'])
  })

  it('Jaccard：交集 ÷ 并集；两个空集为 0', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3)
    expect(jaccard([], [])).toBe(0)
    expect(jaccard(['a'], ['a'])).toBe(1)
  })
})

// 规范化后交集 7、并集 10 → Jaccard 0.7
const TITLE_A = 'Stainless Steel Kitchen Drawer Organizer Tray Expandable Bamboo'
const TITLE_B = 'Stainless Steel Kitchen Drawer Organizer Tray Expandable White Large'

describe('自动归并（specs/product-clustering）', () => {
  it('GTIN 相同归为一簇，归并方式 gtin，置信度 0.95（UPC 与 EAN 前导 0 等价）', () => {
    const { members, createdClusterIds } = assignClusters({
      products: [p('111', { gtin: '012345678905' }), p('222', { gtin: '0012345678905' })],
      existing: [],
      newClusterId: ids(),
    })
    expect(createdClusterIds).toEqual(['c1'])
    expect(members).toEqual([
      { clusterId: 'c1', productKey: 'ebay-us:111', method: 'seed', confidence: 1, locked: false },
      {
        clusterId: 'c1',
        productKey: 'ebay-us:222',
        method: 'gtin',
        confidence: 0.95,
        locked: false,
      },
    ])
  })

  it('标题相似 0.7 且同类目时归并，置信度 = Jaccard', () => {
    expect(jaccard(normalizeTitle(TITLE_A), normalizeTitle(TITLE_B))).toBeCloseTo(0.7)
    const { members } = assignClusters({
      products: [
        p('1', { title: TITLE_A, categoryId: '20625' }),
        p('2', { title: TITLE_B, categoryId: '20625' }),
      ],
      existing: [],
      newClusterId: ids(),
    })
    expect(members[1]).toMatchObject({ clusterId: 'c1', method: 'title', confidence: 0.7 })
  })

  it('标题相似 0.7 但类目不同不归并；类目缺失也不按标题归并', () => {
    const { members, createdClusterIds } = assignClusters({
      products: [
        p('1', { title: TITLE_A, categoryId: '20625' }),
        p('2', { title: TITLE_B, categoryId: '11700' }),
        p('3', { title: TITLE_B }),
      ],
      existing: [],
      newClusterId: ids(),
    })
    expect(createdClusterIds).toEqual(['c1', 'c2', 'c3'])
    expect(new Set(members.map((m) => m.clusterId)).size).toBe(3)
  })

  it('平台 ID 相同即同一商品：已有成员保留原簇，不重复加入', () => {
    const existing = [
      {
        clusterId: 'old',
        productKey: 'ebay-us:1',
        method: 'seed' as const,
        confidence: 1,
        locked: false,
      },
    ]
    const { members, createdClusterIds } = assignClusters({
      products: [p('1', { title: TITLE_A, categoryId: '20625' })],
      existing,
      newClusterId: ids(),
    })
    expect(members).toEqual(existing)
    expect(createdClusterIds).toEqual([])
  })

  it('不跨站点归并；跨站点同款作为簇属性返回', () => {
    const products = [
      p('111', { gtin: '012345678905' }),
      { marketplace: 'amazon-us' as const, platformId: 'B0X', gtin: '012345678905' },
    ]
    const { members } = assignClusters({ products, existing: [], newClusterId: ids() })
    expect(members.map((m) => m.clusterId)).toEqual(['c1', 'c2'])
    expect(crossMarketplaceLinks(members, products)).toEqual([['c1', 'c2']])
  })

  it('品牌词不参与标题相似', () => {
    const { members } = assignClusters({
      products: [
        p('1', { title: 'Acme Silicone Baking Mat', brand: 'Acme', categoryId: 'k' }),
        p('2', { title: 'Zenith Silicone Baking Mat', brand: 'Zenith', categoryId: 'k' }),
      ],
      existing: [],
      newClusterId: ids(),
    })
    expect(members[1]).toMatchObject({ clusterId: 'c1', method: 'title', confidence: 1 })
  })
})

describe('手动拆分与合并', () => {
  const products = [
    p('a', { gtin: '012345678905' }),
    p('b', { gtin: '012345678905' }),
    p('c', { gtin: '012345678905' }),
  ]

  it('拆分后次日自动归并不会把成员合回原簇', () => {
    const day1 = assignClusters({ products, existing: [], newClusterId: ids() })
    expect(new Set(day1.members.map((m) => m.clusterId))).toEqual(new Set(['c1']))

    const split = splitMember(day1.members, productKey(products[1] as ClusterProduct), 'manual-1')
    expect(split[1]).toMatchObject({ clusterId: 'manual-1', method: 'manual', locked: true })

    const day2 = assignClusters({
      products,
      existing: split,
      knownProducts: products,
      newClusterId: ids(),
    })
    const b = day2.members.find((m) => m.productKey === 'ebay-us:b')
    expect(b).toMatchObject({ clusterId: 'manual-1', locked: true })
    expect(day2.members.filter((m) => m.clusterId === 'c1').map((m) => m.productKey)).toEqual([
      'ebay-us:a',
      'ebay-us:c',
    ])
    expect(day2.createdClusterIds).toEqual([])
  })

  it('合并两个簇：成员并入目标簇并锁定', () => {
    const members = [
      {
        clusterId: 'x',
        productKey: 'ebay-us:1',
        method: 'seed' as const,
        confidence: 1,
        locked: false,
      },
      {
        clusterId: 'y',
        productKey: 'ebay-us:2',
        method: 'seed' as const,
        confidence: 1,
        locked: false,
      },
    ]
    expect(mergeClusters(members, 'y', 'x')).toEqual([
      members[0],
      { clusterId: 'x', productKey: 'ebay-us:2', method: 'manual', confidence: 1, locked: true },
    ])
  })
})
