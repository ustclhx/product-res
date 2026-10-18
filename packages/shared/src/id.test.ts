import { describe, expect, it } from 'vitest'
import { isUuidV7, newId } from './id.ts'

describe('newId', () => {
  it('generates UUIDv7 strings', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isUuidV7(id)).toBe(true)
  })

  it('is strictly increasing in generation order, including within the same millisecond', () => {
    const ids = Array.from({ length: 10_000 }, () => newId())
    // 字符串排序后与生成顺序一致，且无重复，即严格递增
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rejects non-v7 values', () => {
    expect(isUuidV7('00000000-0000-4000-8000-000000000000')).toBe(false)
    expect(isUuidV7('not-a-uuid')).toBe(false)
  })
})
