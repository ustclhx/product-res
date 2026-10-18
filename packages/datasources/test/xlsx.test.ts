import { describe, expect, it } from 'vitest'
import {
  detectImportKind,
  parseImportFile,
  parseXlsx,
  XLSX_CONTENT_TYPE,
  XlsxSheetNotFoundError,
} from '../src/index.ts'
import { buildXlsx } from './xlsx-fixture.ts'

// 2026-03-05 的 Excel 序列号
const MARCH_5_2026 = 46086

const workbook = buildXlsx([
  {
    name: '报价',
    rows: [
      ['ASIN', '日期', '价格', '销量'],
      ['B01', { date: MARCH_5_2026 }, 12.5, 1234],
      [null, null, null, null],
      ['B02', { date: MARCH_5_2026 + 1 }, 0.1, null],
      [],
      ['B03 & 杯', null, 123456789.123456, 7],
    ],
  },
  { name: 'Other', rows: [['x'], ['1']] },
])

describe('parseXlsx', () => {
  it('默认第一个工作表：表头、日期转 ISO、数字不丢精度、跳过空行', async () => {
    const result = await parseXlsx(workbook)
    expect(result.sheetNames).toEqual(['报价', 'Other'])
    expect(result.sheetName).toBe('报价')
    expect(result.table).toEqual([
      ['ASIN', '日期', '价格', '销量'],
      ['B01', '2026-03-05', '12.5', '1234'],
      ['B02', '2026-03-06', '0.1', ''],
      ['B03 & 杯', '', '123456789.123456', '7'],
    ])
  })

  it('可按名称指定工作表，不存在时报错', async () => {
    expect((await parseXlsx(workbook, 'Other')).table).toEqual([['x'], ['1']])
    await expect(parseXlsx(workbook, '不存在')).rejects.toBeInstanceOf(XlsxSheetNotFoundError)
  })

  it('非 xlsx 内容抛错而不是返回空表', async () => {
    await expect(parseXlsx(new TextEncoder().encode('a,b\n1,2'))).rejects.toThrow()
  })
})

describe('parseImportFile 按类型分派', () => {
  it('.xlsx 走 XLSX，.csv/.tsv 走 CSV，其余不支持', async () => {
    const xlsx = await parseImportFile('报价.XLSX', workbook)
    expect(xlsx.kind).toBe('xlsx')
    expect(xlsx.contentType).toBe(XLSX_CONTENT_TYPE)
    expect(xlsx.table[0]).toEqual(['ASIN', '日期', '价格', '销量'])

    const csv = await parseImportFile('a.csv', new TextEncoder().encode('a,b\n1,2'))
    expect(csv).toMatchObject({ kind: 'csv', contentType: 'text/csv', sheetNames: [] })
    expect(csv.table).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])

    expect(detectImportKind('legacy.xls')).toBeNull()
    await expect(parseImportFile('legacy.xls', workbook)).rejects.toThrow()
  })
})
