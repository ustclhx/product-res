import { describe, expect, it } from 'vitest'
import { reviewTerms } from '../src/index.ts'

describe('reviewTerms', () => {
  it('同一评论内重复的词只计一次，停用词与低频词被去掉，保留评论引用', () => {
    const terms = reviewTerms([
      { id: 'r1', title: 'Broke fast', body: 'The bowl broke after a week. Broke again!' },
      { id: 'r2', title: null, body: 'Bowl slides on the floor and broke' },
      { id: 'r3', title: '底部打滑', body: '底部打滑，不好清洗' },
      { id: 'r4', body: '底部打滑' },
    ])
    expect(terms.find((t) => t.term === 'broke')).toEqual({
      term: 'broke',
      count: 2,
      reviewIds: ['r1', 'r2'],
    })
    expect(terms.find((t) => t.term === 'bowl')?.count).toBe(2)
    expect(terms.find((t) => t.term === '底部打滑')?.reviewIds).toEqual(['r3', 'r4'])
    expect(terms.some((t) => t.term === 'the' || t.term === 'floor')).toBe(false)
  })

  it('没有评论返回空数组', () => {
    expect(reviewTerms([])).toEqual([])
  })
})
