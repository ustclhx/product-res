import type { InsightProduct, Sourced } from './types.ts'

export interface MatrixRow {
  id: string
  title: string | null
  price: Sourced<number> | null
  rating: Sourced<number> | null
  reviewCount: Sourced<number> | null
  salesMonthly: Sourced<number> | null
}

export interface BubblePoint {
  id: string
  /** 价格 */
  x: number
  /** 月销量估算 */
  y: number
  /** 评论数；缺失保持 null，由图表决定默认大小 */
  size: number | null
}

export interface CompetitorMatrix {
  rows: MatrixRow[]
  bubbles: BubblePoint[]
  /** 因缺价格或销量估算而无法画入气泡图的商品数 */
  bubblesSkipped: number
}

/** 头部 N（默认 20）按月销量估算降序；缺销量估算的排在最后，缺值保持 null。 */
export function competitorMatrix(
  products: readonly InsightProduct[],
  opts: { topN?: number } = {},
): CompetitorMatrix {
  const topN = opts.topN ?? 20
  const sorted = [...products].sort((a, b) => {
    const x = a.salesMonthly?.value
    const y = b.salesMonthly?.value
    if (x === undefined && y === undefined) return a.id.localeCompare(b.id)
    if (x === undefined) return 1
    if (y === undefined) return -1
    return y - x || a.id.localeCompare(b.id)
  })
  const rows: MatrixRow[] = sorted.slice(0, Math.max(0, topN)).map((p) => ({
    id: p.id,
    title: p.title ?? null,
    price: p.price ?? null,
    rating: p.rating ?? null,
    reviewCount: p.reviewCount ?? null,
    salesMonthly: p.salesMonthly ?? null,
  }))
  const bubbles: BubblePoint[] = []
  for (const r of rows) {
    if (r.price && r.salesMonthly) {
      bubbles.push({
        id: r.id,
        x: r.price.value,
        y: r.salesMonthly.value,
        size: r.reviewCount?.value ?? null,
      })
    }
  }
  return { rows, bubbles, bubblesSkipped: rows.length - bubbles.length }
}
