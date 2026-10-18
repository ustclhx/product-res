import { parseDate, parseNumber } from '@product-res/datasources'
import type { QuoteTier } from '@product-res/db'

export { QUOTE_IMPORT_SOURCE } from './quote-template.ts'

/**
 * 供应商报价表导入（specs/supplier-quotes「报价导入」，tasks 2.3）的纯解析：一行一个报价，
 * 按簇 ID 或平台商品 ID（ASIN / ItemID）关联商品簇。空单元格保持为空，不补默认 0。
 */

type Field =
  | 'clusterId'
  | 'platformId'
  | 'supplier'
  | 'supplierUrl'
  | 'supplierPlatform'
  | 'tiers'
  | 'unitPrice'
  | 'currency'
  | 'moq'
  | 'weightG'
  | 'dimensions'
  | 'length'
  | 'width'
  | 'height'
  | 'confidence'
  | 'quotedOn'
  | 'procurementDays'
  | 'note'

const HEADER_ALIASES: Record<Field, string[]> = {
  clusterId: ['簇id', '商品簇id', 'clusterid', 'cluster_id', 'cluster'],
  platformId: [
    '平台商品id',
    '平台id',
    'asin',
    'itemid',
    'item_id',
    'platformid',
    'platform_id',
    'sku',
  ],
  supplier: ['供应商', '供应商名称', 'supplier', 'suppliername', 'supplier_name', '工厂'],
  supplierUrl: ['供应商链接', '链接', '货源链接', 'url', 'supplierurl', 'supplier_url', 'link'],
  supplierPlatform: ['供应商平台', '货源平台', 'platform', 'supplierplatform', 'supplier_platform'],
  tiers: ['阶梯价', '阶梯', '阶梯报价', 'tiers', 'pricetiers', 'price_tiers'],
  unitPrice: ['单价', '采购单价', 'unitprice', 'unit_price', 'price'],
  currency: ['币种', '货币', 'currency'],
  moq: ['moq', '起订量', '最小起订量'],
  weightG: ['重量(g)', '重量g', '重量', '单件重量', 'weight', 'weightg', 'weight_g'],
  dimensions: ['尺寸(cm)', '尺寸cm', '尺寸', '包装尺寸', 'dimensions', 'size'],
  length: ['长(cm)', '长cm', '长', 'length'],
  width: ['宽(cm)', '宽cm', '宽', 'width'],
  height: ['高(cm)', '高cm', '高', 'height'],
  confidence: ['可信度', '报价类型', 'confidence'],
  quotedOn: ['报价日期', '日期', 'quotedon', 'quoted_on', 'date'],
  procurementDays: [
    '采购天数',
    '交期',
    '交期(天)',
    '生产天数',
    'procurementdays',
    'procurement_days',
    'leadtime',
  ],
  note: ['备注', 'note', 'notes', 'remark'],
}

const normalizeHeader = (h: string) =>
  h.trim().toLowerCase().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')')

export function mapHeaders(headers: readonly string[]) {
  const columns = new Map<Field, number>()
  const unknown: string[] = []
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    const field = (Object.keys(HEADER_ALIASES) as Field[]).find((f) =>
      HEADER_ALIASES[f].includes(n),
    )
    if (field && !columns.has(field)) columns.set(field, i)
    else if (n) unknown.push(h)
  })
  return { columns, unknown }
}

export interface QuoteDraft {
  /** 文件中的行号（表头为第 0 行） */
  row: number
  clusterId: string | null
  platformId: string | null
  supplier: { name: string; url: string | null; platform: '1688' | 'alibaba' | 'other' }
  tiers: QuoteTier[]
  currency: string
  moq: number | null
  weightG: number | null
  dimensions: { lengthCm: number; widthCm: number; heightCm: number } | null
  confidence: 'public' | 'confirmed'
  quotedOn: string
  procurementDays: number | null
  note: string | null
}

export interface QuoteIssue {
  row: number
  column?: string
  message: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 主单位价格 → 最小单位整数；无法解析返回 undefined，空返回 null */
function minorOf(raw: string): number | null | undefined {
  const n = parseNumber(raw)
  if (n === null || n === undefined) return n
  if (n < 0) return undefined
  return Math.round(n * 100)
}

function positiveInt(raw: string): number | null | undefined {
  const n = parseNumber(raw)
  if (n === null || n === undefined) return n
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** “100:12; 500:10.5” / “100=12，500=10.5” / “100件 ¥12” → 阶梯 */
export function parseTiers(raw: string): QuoteTier[] | null | undefined {
  const text = raw.trim()
  if (!text) return null
  const tiers: QuoteTier[] = []
  for (const part of text.split(/[;；\n|]+/)) {
    const p = part.trim()
    if (!p) continue
    const m = /^(\d+)\s*(?:件|pcs|个)?\s*[:：=＝@\s]\s*(.+)$/i.exec(p)
    if (!m) return undefined
    const qty = Number(m[1])
    const price = minorOf((m[2] as string).replace(/[/／]\s*(件|个|pcs)$/i, ''))
    if (!(qty > 0) || price === null || price === undefined) return undefined
    tiers.push({ minQty: qty, unitPriceMinor: price })
  }
  if (tiers.length === 0) return null
  if (new Set(tiers.map((t) => t.minQty)).size !== tiers.length) return undefined
  return tiers.sort((a, b) => a.minQty - b.minQty)
}

/** “30x20x10” / “30*20*10” / “30×20×10 cm” */
export function parseDimensions(raw: string) {
  const text = raw.trim()
  if (!text) return null
  const m = /^(\d+(?:\.\d+)?)\s*[x×*X]\s*(\d+(?:\.\d+)?)\s*[x×*X]\s*(\d+(?:\.\d+)?)\s*(cm)?$/i.exec(
    text,
  )
  if (!m) return undefined
  const [l, w, h] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!(l > 0 && w > 0 && h > 0)) return undefined
  return { lengthCm: l, widthCm: w, heightCm: h }
}

function supplierPlatform(raw: string, url: string | null): QuoteDraft['supplier']['platform'] {
  const t = raw.trim().toLowerCase()
  if (t === '1688') return '1688'
  if (t.includes('alibaba') || t.includes('阿里巴巴国际')) return 'alibaba'
  if (t) return 'other'
  if (url && /1688\.com/i.test(url)) return '1688'
  if (url && /alibaba\.com/i.test(url)) return 'alibaba'
  return 'other'
}

function confidenceOf(raw: string): QuoteDraft['confidence'] | undefined {
  const t = raw.trim().toLowerCase()
  if (!t || t === '公开' || t === '公开价' || t === 'public') return 'public'
  if (t === '已确认' || t === '确认' || t === '已确认报价' || t === 'confirmed') return 'confirmed'
  return undefined
}

/**
 * 解析整张表：每行得到一个报价草稿或若干问题。缺少簇与平台商品 ID、供应商、价格的行为错误行；
 * 币种为空时用导入时选择的默认币种，报价日期为空时用导入当天。
 */
export function parseQuoteTable(
  table: readonly (readonly string[])[],
  defaults: { currency: string; quotedOn: string },
) {
  const [headers = [], ...rows] = table
  const { columns, unknown } = mapHeaders(headers)
  const issues: QuoteIssue[] = []
  const drafts: QuoteDraft[] = []
  if (!columns.has('clusterId') && !columns.has('platformId'))
    issues.push({ row: 0, message: '缺少“簇 ID”或“平台商品 ID”列' })
  if (!columns.has('supplier')) issues.push({ row: 0, message: '缺少“供应商”列' })
  if (!columns.has('tiers') && !columns.has('unitPrice'))
    issues.push({ row: 0, message: '缺少“阶梯价”或“单价”列' })
  if (issues.length > 0) return { headers: [...headers], drafts, issues, errorRows: [], unknown }

  const errorRows = new Set<number>()
  rows.forEach((cells, i) => {
    const rowNo = i + 1
    if (cells.every((c) => !String(c ?? '').trim())) return
    const get = (f: Field) => {
      const idx = columns.get(f)
      return idx === undefined ? '' : String(cells[idx] ?? '').trim()
    }
    const fail = (column: string, message: string) => {
      issues.push({ row: rowNo, column, message })
      errorRows.add(rowNo)
    }

    const clusterId = get('clusterId') || null
    const platformId = get('platformId') || null
    if (!clusterId && !platformId) fail('簇 ID', '簇 ID 与平台商品 ID 至少填一个')
    if (clusterId && !UUID.test(clusterId)) fail('簇 ID', '簇 ID 格式不正确')
    const name = get('supplier')
    if (!name) fail('供应商', '供应商名称为空')
    const url = get('supplierUrl') || null
    if (url && !/^https?:\/\//i.test(url)) fail('供应商链接', '链接须以 http:// 或 https:// 开头')

    const moq = positiveInt(get('moq'))
    if (moq === undefined) fail('MOQ', 'MOQ 须为正整数')
    let tiers = parseTiers(get('tiers'))
    if (tiers === undefined) fail('阶梯价', '阶梯价格式应为“数量:单价; 数量:单价”')
    if (tiers === null) {
      const unit = minorOf(get('unitPrice'))
      if (unit === undefined) fail('单价', '单价无法解析')
      else if (unit === null) fail('阶梯价', '阶梯价与单价都为空')
      else tiers = [{ minQty: moq ?? 1, unitPriceMinor: unit }]
    }
    const currency = (get('currency') || defaults.currency).toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) fail('币种', '币种为 3 位代码，如 CNY / USD')
    const weight = positiveInt(get('weightG'))
    if (weight === undefined) fail('重量(g)', '重量须为正整数克')
    let dimensions = parseDimensions(get('dimensions'))
    if (dimensions === undefined) fail('尺寸(cm)', '尺寸格式应为“长x宽x高”')
    if (dimensions === null && (get('length') || get('width') || get('height'))) {
      const [l, w, h] = (['length', 'width', 'height'] as const).map((f) => parseNumber(get(f)))
      if (
        typeof l === 'number' &&
        typeof w === 'number' &&
        typeof h === 'number' &&
        l > 0 &&
        w > 0 &&
        h > 0
      )
        dimensions = { lengthCm: l, widthCm: w, heightCm: h }
      else fail('尺寸(cm)', '长、宽、高须同时填写正数')
    }
    const confidence = confidenceOf(get('confidence'))
    if (!confidence) fail('可信度', '可信度填“公开价”或“已确认”')
    const quotedOn = get('quotedOn') ? parseDate(get('quotedOn')) : defaults.quotedOn
    if (!quotedOn) fail('报价日期', '报价日期无法解析')
    const days = get('procurementDays') ? parseNumber(get('procurementDays')) : null
    if (days !== null && (days === undefined || !Number.isInteger(days) || days < 0 || days > 365))
      fail('采购天数', '采购天数须为 0–365 的整数')

    if (errorRows.has(rowNo)) return
    drafts.push({
      row: rowNo,
      clusterId,
      platformId,
      supplier: { name, url, platform: supplierPlatform(get('supplierPlatform'), url) },
      tiers: tiers as QuoteTier[],
      currency,
      moq: moq ?? null,
      weightG: weight ?? null,
      dimensions: dimensions ?? null,
      confidence: confidence as QuoteDraft['confidence'],
      quotedOn: quotedOn as string,
      procurementDays: days ?? null,
      note: get('note') || null,
    })
  })
  return {
    headers: [...headers],
    drafts,
    issues,
    errorRows: [...errorRows].sort((a, b) => a - b),
    unknown,
  }
}
