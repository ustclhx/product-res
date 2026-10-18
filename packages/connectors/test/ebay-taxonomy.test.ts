import { readFileSync } from 'node:fs'
import type { FetchTask, RawPayload } from '@product-res/datasources'
import { describe, expect, it } from 'vitest'
import { createEbayBrowseConnector, normalizeCategoryTree, normalizeEbay } from '../src/index.ts'

// 类目树夹具按官方 getCategoryTree 文档结构编写，真实响应待凭据核验
describe('eBay Taxonomy（文档样例）', () => {
  const tree = readFileSync(new URL('./fixtures/ebay-category-tree.json', import.meta.url), 'utf8')
  const task: FetchTask = { kind: 'taxonomy', marketplace: 'ebay-us', scope: {} }
  const raw = (body: string, url: string): RawPayload => ({
    sourceId: 'ebay-browse',
    task,
    request: { method: 'GET', url },
    status: 200,
    body,
    fetchedAt: '2026-10-19T00:00:00.000Z',
  })

  it('归一化为类目 ID、名称、父 ID、叶子与层级路径', () => {
    const categories = normalizeCategoryTree(tree)
    expect(categories.map((c) => c.categoryId)).toEqual(['6000', '6030', '33694', '281'])
    expect(categories[0]).toMatchObject({ parentId: null, leaf: false, path: 'eBay Motors' })
    expect(categories[2]).toMatchObject({
      parentId: '6030',
      leaf: true,
      path: 'eBay Motors > Parts & Accessories > Interior',
      treeVersion: '131',
    })
    expect(categories[3]).toMatchObject({ parentId: null, leaf: true })
  })

  it('只有类目树响应产出类目，默认树 ID 响应不产出', () => {
    const idBatch = normalizeEbay(
      raw(
        JSON.stringify({ categoryTreeId: '0', categoryTreeVersion: '131' }),
        'https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id',
      ),
    )
    expect(idBatch.categories ?? []).toHaveLength(0)
    const treeBatch = normalizeEbay(
      raw(tree, 'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0'),
    )
    expect(treeBatch.categories).toHaveLength(4)
  })

  it('两次请求各计 1 次调用', async () => {
    const ebay = createEbayBrowseConnector()
    expect(ebay.capabilities).toContain('taxonomy')
    expect(ebay.plan(task)).toBe(2)
    const urls: string[] = []
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      const body = url.includes('oauth2/token')
        ? { access_token: 't', expires_in: 7200 }
        : url.includes('get_default_category_tree_id')
          ? { categoryTreeId: '0', categoryTreeVersion: '131' }
          : JSON.parse(tree)
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const result = await ebay.fetch(task, {
      fetch: fake,
      secret: () => 'x',
      now: () => new Date('2026-10-19T00:00:00Z'),
    })
    expect(result.cost).toBe(2)
    expect(result.payloads).toHaveLength(2)
    expect(urls.filter((u) => u.includes('/commerce/taxonomy/'))).toEqual([
      'https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US',
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0',
    ])
  })
})
