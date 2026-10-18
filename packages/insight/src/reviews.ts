import type { InsightReview } from './types.ts'

export interface NegativeReviewInput {
  id: string
  productId: string
  rating: number
  title: string
  body: string
  truncated: boolean
  sourceId: string
}

export type NegativeReviews =
  | { status: 'no-source' }
  | {
      status: 'ok'
      items: NegativeReviewInput[]
      totalReviews: number
      /** 评分 ≤ 阈值的评论数（含被 maxReviews 截掉的） */
      negativeCount: number
      /** 缺评分而无法判断的评论数 */
      excludedNoRating: number
    }

function cut(s: string | null | undefined, max: number): { text: string; truncated: boolean } {
  const chars = Array.from((s ?? '').trim())
  return chars.length > max
    ? { text: `${chars.slice(0, max).join('')}…`, truncated: true }
    : { text: chars.join(''), truncated: false }
}

/** 筛出评分 ≤ 3 的评论，整理成供 AI 归纳的输入。没有任何评论返回 { status: 'no-source' }。 */
export function selectNegativeReviews(
  reviews: readonly InsightReview[],
  opts: {
    maxRating?: number
    maxBodyChars?: number
    maxTitleChars?: number
    maxReviews?: number
  } = {},
): NegativeReviews {
  if (reviews.length === 0) return { status: 'no-source' }
  const maxRating = opts.maxRating ?? 3
  const maxBody = opts.maxBodyChars ?? 500
  const maxTitle = opts.maxTitleChars ?? 120
  let excludedNoRating = 0
  const negatives: { review: InsightReview; rating: number }[] = []
  for (const r of reviews) {
    if (r.rating === null || !Number.isFinite(r.rating)) excludedNoRating++
    else if (r.rating <= maxRating) negatives.push({ review: r, rating: r.rating })
  }
  const limited = opts.maxReviews === undefined ? negatives : negatives.slice(0, opts.maxReviews)
  const items = limited.map(({ review: r, rating }) => {
    const title = cut(r.title, maxTitle)
    const body = cut(r.body, maxBody)
    return {
      id: r.id,
      productId: r.productId,
      rating,
      title: title.text,
      body: body.text,
      truncated: title.truncated || body.truncated,
      sourceId: r.sourceId,
    }
  })
  return {
    status: 'ok',
    items,
    totalReviews: reviews.length,
    negativeCount: negatives.length,
    excludedNoRating,
  }
}
