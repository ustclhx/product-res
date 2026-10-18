/**
 * 供应商报价导入模板（客户端可引用，不依赖解析库）：来源 ID、模板列与示例行、CSV 生成。
 * 列名别名与解析见 quote-import.ts。
 */

export const QUOTE_IMPORT_SOURCE = 'supplier-quote'

/** 导入模板的列（数据中心可下载），表头别名见 HEADER_ALIASES */
export const QUOTE_TEMPLATE_HEADERS = [
  '簇 ID',
  '平台商品 ID',
  '供应商',
  '供应商链接',
  '供应商平台',
  '阶梯价',
  '币种',
  'MOQ',
  '重量(g)',
  '尺寸(cm)',
  '可信度',
  '报价日期',
  '采购天数',
  '备注',
] as const

export const QUOTE_TEMPLATE_EXAMPLE = [
  '',
  'B0C1234567',
  '义乌某某日用品厂',
  'https://detail.1688.com/offer/123.html',
  '1688',
  '100:12.00; 500:10.50',
  'CNY',
  '100',
  '380',
  '30x20x10',
  '公开价',
  '2026-10-18',
  '12',
  '',
]

/** 下载用的 CSV 模板（带一行示例） */
export function quoteTemplateCsv() {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  return `${[QUOTE_TEMPLATE_HEADERS, QUOTE_TEMPLATE_EXAMPLE].map((r) => r.map(esc).join(',')).join('\n')}\n`
}
