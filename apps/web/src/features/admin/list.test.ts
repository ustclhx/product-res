import { describe, expect, it } from 'vitest'
import {
  ADMIN_PAGE_SIZE,
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from './list.ts'

describe('后台列表的 search 参数', () => {
  const parse = adminListSearch(['q', 'status'])

  it('offset 取非负整数并限制上限，非法值回到第一页', () => {
    expect(parse({})).toEqual({ offset: 0 })
    expect(parse({ offset: '100' })).toEqual({ offset: 100 })
    expect(parse({ offset: -5 })).toEqual({ offset: 0 })
    expect(parse({ offset: 'abc' })).toEqual({ offset: 0 })
    expect(parse({ offset: 10.7 })).toEqual({ offset: 10 })
    expect(parse({ offset: 9_999_999 })).toEqual({ offset: 100_000 })
  })

  it('只保留声明的筛选键，去掉空白与空值并限制长度', () => {
    expect(parse({ q: '  ada ', status: '', other: 'x' })).toEqual({ offset: 0, q: 'ada' })
    expect(parse({ q: 42 })).toEqual({ offset: 0, q: '42' })
    expect(parse({ q: { nested: true } })).toEqual({ offset: 0 })
    expect(parse({ q: 'x'.repeat(500) }).q).toHaveLength(200)
  })

  it('提交筛选后回到第一页', () => {
    expect(filtersToSearch(['q', 'status'], { q: 'ada', status: 'active', junk: '1' })).toEqual({
      offset: 0,
      q: 'ada',
      status: 'active',
    })
  })

  it('offset 与页码互相换算，未知总数时用 hasMore', () => {
    expect(adminListPage(ADMIN_PAGE_SIZE * 2, { hasMore: true })).toEqual({
      pageIndex: 2,
      pageSize: ADMIN_PAGE_SIZE,
      hasMore: true,
    })
    expect(adminListPage(0, { rowCount: 7 })).toEqual({
      pageIndex: 0,
      pageSize: ADMIN_PAGE_SIZE,
      rowCount: 7,
    })
    expect(offsetOfPage(3)).toBe(ADMIN_PAGE_SIZE * 3)
  })
})
