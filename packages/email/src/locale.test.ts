import { describe, expect, it } from 'vitest'
import { resolveEmailLocale } from './locale.ts'

describe('resolveEmailLocale', () => {
  it('旧消息与不支持的用户语言回退到配置的默认语言', () => {
    expect(resolveEmailLocale(undefined, 'zh')).toBe('zh')
    expect(resolveEmailLocale('fr', 'zh')).toBe('zh')
  })

  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh_Hant', 'zh'],
    [' ZH-tw ', 'zh'],
    ['fr', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('%j → %s', (input, expected) => {
    expect(resolveEmailLocale(input)).toBe(expected)
  })
})
