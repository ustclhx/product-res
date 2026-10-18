import { describe, expect, it } from 'vitest'
import { buildImport, parseCsv, parseDate, parseNumber, suggestMapping } from '../src/index.ts'

describe('parseCsv', () => {
  it('处理 BOM、引号、转义引号与 CRLF', () => {
    expect(parseCsv('﻿ASIN,Title\r\nB01,"Cup, ""big"""\r\n')).toEqual([
      ['ASIN', 'Title'],
      ['B01', 'Cup, "big"'],
    ])
  })

  it('自动识别制表符分隔', () => {
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('值解析', () => {
  it('数字：千分位、货币、百分比、万；空值为 null，不能解析为 undefined', () => {
    expect(parseNumber('1,234')).toBe(1234)
    expect(parseNumber('$12.50')).toBe(12.5)
    expect(parseNumber('12%')).toBeCloseTo(0.12)
    expect(parseNumber('1.2万')).toBe(12000)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('—')).toBeNull()
    expect(parseNumber('abc')).toBeUndefined()
  })

  it('日期：多种格式与 Excel 序列号', () => {
    expect(parseDate('2026/10/18')).toBe('2026-10-18')
    expect(parseDate('2026年10月18日')).toBe('2026-10-18')
    expect(parseDate('10/18/2026')).toBe('2026-10-18')
    expect(parseDate(46313)).toBe('2026-10-18')
    expect(parseDate('2026-02-30')).toBeUndefined()
  })
})

describe('列映射与导入预览（specs/data-import）', () => {
  const headers = ['ASIN', 'Title', 'Price', 'ASIN Sales', 'BSR', 'Extra Column']

  it('自动识别常见表头，多出的列标为未映射', () => {
    const { mapping, unmatched } = suggestMapping(headers)
    expect(mapping.ASIN).toEqual({ kind: 'platformId' })
    expect(mapping['ASIN Sales']).toEqual({ kind: 'metric', metric: 'sales_estimate_monthly' })
    expect(unmatched).toEqual(['Extra Column'])
  })

  it('复用已保存模板', () => {
    const saved = { 'Extra Column': { kind: 'metric', metric: 'review_count' } as const }
    expect(suggestMapping(headers, saved).mapping['Extra Column']).toEqual(saved['Extra Column'])
  })

  it('空单元格不生成观测，错误行单独列出', () => {
    const { mapping } = suggestMapping(headers)
    const preview = buildImport(
      headers,
      [
        ['B01', 'Cup', '$9.99', '', '1,200', 'x'],
        ['', 'No id', '1', '2', '3', 'x'],
        ['B02', 'Pan', 'abc', '30', '', 'x'],
      ],
      mapping,
      {
        sourceId: 'helium10',
        marketplace: 'amazon-us',
        entityType: 'product',
        observedOn: '2026-10-18',
      },
    )
    expect(preview.observations).toEqual([
      expect.objectContaining({ metric: 'price', value: 9.99, currency: 'USD', method: 'import' }),
      expect.objectContaining({ metric: 'bsr', value: 1200 }),
    ])
    expect(preview.observations.some((o) => o.metric === 'sales_estimate_monthly')).toBe(false)
    expect(preview.errorRows).toEqual([2, 3])
    expect(preview.entities.map((e) => e.key.platformId)).toEqual(['B01'])
  })

  it('没有日期列也没有上下文日期时整体报错', () => {
    const { mapping } = suggestMapping(['ASIN', 'Price'])
    const preview = buildImport(['ASIN', 'Price'], [['B01', '1']], mapping, {
      sourceId: 'x',
      marketplace: 'amazon-us',
      entityType: 'product',
    })
    expect(preview.issues[0]?.message).toContain('日期')
    expect(preview.observations).toEqual([])
  })
})
