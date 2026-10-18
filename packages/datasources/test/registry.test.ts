import { describe, expect, it } from 'vitest'
import { createMockConnector, createRegistry } from '../src/index.ts'

describe('数据源注册表', () => {
  it('只派发给已启用且声明了能力与站点的数据源', () => {
    const mock = createMockConnector()
    const registry = createRegistry([mock])
    expect(registry.providers('product-snapshot', 'amazon-us', new Set(['mock']))).toEqual([mock])
    expect(registry.providers('product-snapshot', 'amazon-us', new Set())).toEqual([])
    expect(registry.providers('reviews', 'amazon-us', new Set(['mock']))).toEqual([])
    expect(registry.providers('product-snapshot', 'amazon-uk', new Set(['mock']))).toEqual([])
  })

  it('拒绝重复 ID', () => {
    expect(() => createRegistry([createMockConnector(), createMockConnector()])).toThrow()
  })

  it('模拟数据源可以模拟字段缺失', () => {
    const mock = createMockConnector({ missingMetrics: ['available_quantity'] })
    const batch = mock.normalize({
      sourceId: 'mock',
      task: { kind: 'product-snapshot', marketplace: 'ebay-us', scope: { ids: ['1'] } },
      request: { method: 'GET', url: 'https://mock.invalid' },
      status: 200,
      body: JSON.stringify({ items: [{ id: '1', title: 't', price: 1, available: 3 }] }),
      fetchedAt: '2026-10-18T00:00:00Z',
    })
    expect(batch.observations.map((o) => o.metric)).toEqual(['price'])
  })
})
