import { isMetric, METRICS, type MetricName } from '../metrics.ts'
import type {
  AcquisitionMethod,
  EntityType,
  Marketplace,
  NormalizedEntity,
  NormalizedObservation,
} from '../types.ts'
import { isEmptyCell, parseDate, parseNumber } from './values.ts'

/** 一列对应的目标：实体字段、观测日期或某个指标 */
export type ColumnTarget =
  | { readonly kind: 'platformId' }
  | { readonly kind: 'title' }
  | { readonly kind: 'brand' }
  | { readonly kind: 'gtin' }
  | { readonly kind: 'url' }
  | { readonly kind: 'observedOn' }
  | { readonly kind: 'metric'; readonly metric: MetricName; readonly currency?: string }
  | { readonly kind: 'ignore' }

export type ColumnMapping = Readonly<Record<string, ColumnTarget>>

/** 列名同义词（小写、去空白与符号后比较）；覆盖常见工具导出的中英文表头 */
const SYNONYMS: ReadonlyArray<readonly [ColumnTarget, readonly string[]]> = [
  [
    { kind: 'platformId' },
    [
      'asin',
      'itemid',
      'itemnumber',
      'ebayitemid',
      '商品id',
      '商品编号',
      'listingid',
      'productid',
      'keyword',
      '关键词',
      '搜索词',
      'sellerid',
      '卖家id',
    ],
  ],
  [
    { kind: 'title' },
    ['title', 'producttitle', 'productname', 'name', '标题', '商品标题', '商品名称'],
  ],
  [{ kind: 'brand' }, ['brand', '品牌']],
  [{ kind: 'gtin' }, ['upc', 'ean', 'gtin', 'isbn']],
  [{ kind: 'url' }, ['url', 'link', 'producturl', '链接', '商品链接']],
  [{ kind: 'observedOn' }, ['date', 'day', '日期', '时间', 'snapshotdate']],
  [
    { kind: 'metric', metric: 'price' },
    ['price', 'currentprice', 'saleprice', '价格', '售价', '当前价格'],
  ],
  [
    { kind: 'metric', metric: 'sales_estimate_monthly' },
    [
      'monthlysales',
      'asinsales',
      'estmonthlysales',
      'sales',
      'unitssold',
      '月销量',
      '月销量估算',
      '近30天销量',
    ],
  ],
  [
    { kind: 'metric', metric: 'revenue_estimate_monthly' },
    ['monthlyrevenue', 'asinrevenue', 'revenue', '月销售额', '月销售额估算'],
  ],
  [
    { kind: 'metric', metric: 'bsr' },
    ['bsr', 'salesrank', 'bestsellersrank', '大类排名', 'bsr排名', '排名'],
  ],
  [{ kind: 'metric', metric: 'rating' }, ['rating', 'ratings', 'stars', '评分', '星级']],
  [
    { kind: 'metric', metric: 'review_count' },
    ['reviews', 'reviewcount', 'ratingscount', '评论数', '评分数'],
  ],
  [
    { kind: 'metric', metric: 'seller_count' },
    ['sellers', 'sellercount', 'activesellers', '卖家数'],
  ],
  [
    { kind: 'metric', metric: 'search_volume_monthly' },
    ['searchvolume', 'monthlysearchvolume', '月搜索量', '搜索量'],
  ],
  [
    { kind: 'metric', metric: 'sold_quantity_total' },
    ['totalsold', 'quantitysold', 'sold', '已售', '累计销量'],
  ],
]

const normalize = (header: string) => header.toLowerCase().replace(/[\s_\-()（）:：.#]/g, '')

export interface MappingSuggestion {
  readonly mapping: ColumnMapping
  readonly unmatched: readonly string[]
}

/**
 * 按“已保存模板 → 精确同义词”给出列映射建议；无法识别的列标为未映射，交给用户手动对应。
 * 模板中有、文件中没有的列忽略；文件中多出的列不影响其他列。
 */
export function suggestMapping(
  headers: readonly string[],
  saved?: ColumnMapping,
): MappingSuggestion {
  const mapping: Record<string, ColumnTarget> = {}
  const unmatched: string[] = []
  const taken = new Set<string>()
  for (const header of headers) {
    const fromSaved = saved?.[header]
    if (fromSaved) {
      mapping[header] = fromSaved
      continue
    }
    const key = normalize(header)
    const hit = SYNONYMS.find(
      ([target, names]) => names.includes(key) && !taken.has(targetKey(target)),
    )
    if (hit) {
      mapping[header] = hit[0]
      taken.add(targetKey(hit[0]))
    } else unmatched.push(header)
  }
  return { mapping, unmatched }
}

function targetKey(target: ColumnTarget) {
  return target.kind === 'metric' ? `metric:${target.metric}` : target.kind
}

export interface ImportContext {
  readonly sourceId: string
  readonly marketplace: Marketplace
  readonly entityType: EntityType
  /** 文件中没有日期列时使用的观测日期（YYYY-MM-DD） */
  readonly observedOn?: string
  /** 金额列未注明币种时使用 */
  readonly currency?: string
  readonly method?: AcquisitionMethod
}

export interface ImportIssue {
  /** 数据行号（从 1 开始，不含表头） */
  readonly row: number
  readonly column?: string
  readonly message: string
}

export interface ImportPreview {
  readonly entities: readonly NormalizedEntity[]
  readonly observations: readonly NormalizedObservation[]
  readonly issues: readonly ImportIssue[]
  /** 有错误的行号；确认导入时可选择跳过 */
  readonly errorRows: readonly number[]
  readonly rowCount: number
}

/**
 * 把已映射的表格转成实体与观测值（specs/data-import）：
 * - 空单元格不生成观测（不补零）
 * - 缺少平台 ID、无法解析的数字或日期计为该行错误
 * - 缺少日期列且未提供上下文日期时整体报错
 */
export function buildImport(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  mapping: ColumnMapping,
  context: ImportContext,
): ImportPreview {
  const issues: ImportIssue[] = []
  const errorRows = new Set<number>()
  const entities = new Map<string, NormalizedEntity>()
  const observations: NormalizedObservation[] = []
  const column = (kind: ColumnTarget['kind']) => headers.findIndex((h) => mapping[h]?.kind === kind)
  const idCol = column('platformId')
  const dateCol = column('observedOn')
  if (idCol < 0) issues.push({ row: 0, message: '缺少平台 ID 列（ASIN / ItemID / 关键词）' })
  if (dateCol < 0 && !context.observedOn)
    issues.push({ row: 0, message: '缺少日期列，请补填观测日期' })
  if (issues.length > 0)
    return { entities: [], observations: [], issues, errorRows: [], rowCount: rows.length }
  const method = context.method ?? 'import'

  for (const [index, cells] of rows.entries()) {
    const rowNo = index + 1
    const fail = (columnName: string | undefined, message: string) => {
      issues.push({ row: rowNo, ...(columnName ? { column: columnName } : {}), message })
      errorRows.add(rowNo)
    }
    const rawId = cells[idCol]
    if (isEmptyCell(rawId)) {
      fail(headers[idCol], '平台 ID 为空')
      continue
    }
    const platformId = String(rawId).trim()
    let observedOn = context.observedOn
    if (dateCol >= 0) {
      const parsed = parseDate(cells[dateCol])
      if (parsed === undefined) {
        fail(headers[dateCol], '无法解析的日期')
        continue
      }
      observedOn = parsed ?? context.observedOn
    }
    if (!observedOn) {
      fail(headers[dateCol], '日期为空')
      continue
    }
    const key = { type: context.entityType, marketplace: context.marketplace, platformId }
    const facts: Record<string, string> = {}
    const rowObservations: NormalizedObservation[] = []
    for (const [col, header] of headers.entries()) {
      const target = mapping[header]
      const raw = cells[col]
      if (
        !target ||
        target.kind === 'ignore' ||
        target.kind === 'platformId' ||
        target.kind === 'observedOn'
      )
        continue
      if (target.kind !== 'metric') {
        if (!isEmptyCell(raw)) facts[target.kind] = String(raw).trim()
        continue
      }
      if (!isMetric(target.metric)) {
        fail(header, `未知指标 ${target.metric}`)
        continue
      }
      const value = parseNumber(raw)
      if (value === undefined) {
        fail(header, '无法解析的数字')
        continue
      }
      if (value === null) continue
      const money = METRICS[target.metric].unit === 'money'
      rowObservations.push({
        entity: key,
        metric: target.metric,
        observedOn,
        value,
        ...(money ? { currency: target.currency ?? context.currency ?? 'USD' } : {}),
        method,
      })
    }
    if (errorRows.has(rowNo)) continue
    const id = `${key.marketplace}:${platformId}`
    if (!entities.has(id) || Object.keys(facts).length > 0) entities.set(id, { key, facts })
    observations.push(...rowObservations)
  }
  return {
    entities: [...entities.values()],
    observations,
    issues,
    errorRows: [...errorRows].sort((a, b) => a - b),
    rowCount: rows.length,
  }
}
