/**
 * 品类洞察的夹具数据（集成测试与报告页截图共用）：一个 Amazon US 宠物慢食碗品类。
 * 只生成数据，不连库；调用方按各自的连接方式写入。所有值都是测试夹具，不进入任何真实数据集。
 */

export interface FixtureProduct {
  platformId: string
  title: string
  brand: string
  listedAt: string | null
  price: number
  rating: number
  reviewCount: number
  /** 最近 12 个月的月销量估算（旧 → 新） */
  sales: number[]
  /** 第二个销量来源（交叉验证），只给头部几个 */
  altSales?: number
}

export interface FixtureObservation {
  /** product 用 platformId；keyword 为空 */
  platformId: string | null
  entityType: 'product' | 'keyword'
  metric: string
  observedOn: string
  sourceId: string
  value: number
  currency: string | null
  method: 'official' | 'estimate' | 'derived' | 'import'
}

export interface FixtureReview {
  platformId: string
  reviewId: string
  rating: number
  title: string
  body: string
  reviewedOn: string
}

const pad = (n: number) => String(n).padStart(2, '0')
function monthAdd(year: number, month: number, delta: number) {
  const idx = year * 12 + (month - 1) + delta
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()

const SEASON = [0.82, 0.8, 0.86, 0.9, 0.94, 0.97, 1, 1.04, 1.08, 1.12, 1.2, 1.32]

export function categoryFixture(now: Date, suffix: string) {
  const categoryId = `pet-bowls-${suffix}`
  const keyword = `slow feeder ${suffix}`
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const today = now.toISOString().slice(0, 10)
  const base: [string, string, number, number, number, number, number | null][] = [
    [
      'Outward Hound',
      'Fun Feeder Slo Bowl, Slow Feeder Dog Bowl, Multi-Level Puzzle',
      13.99,
      4.6,
      48210,
      8200,
      400,
    ],
    [
      'JASGOOD',
      'Slow Feeder Dog Bowl Non-Slip Puzzle Bowl for Large Breed',
      11.49,
      4.4,
      21877,
      5600,
      200,
    ],
    [
      'Hyper Pet',
      'Lick Mat for Dogs and Cats, Licking Pad for Anxiety Relief',
      12.99,
      4.5,
      30562,
      4100,
      60,
    ],
    [
      'Neater Pet',
      'Neater Slow Feeder Bowl, Stainless Steel, Bloat Stop',
      18.95,
      4.3,
      9614,
      2600,
      25,
    ],
    [
      'UPSKY',
      'Slow Feeder Dog Bowl Anti-Choking Interactive Bloat Stop',
      9.99,
      4.2,
      12033,
      2300,
      12,
    ],
    ['Dogit', 'Go Slow Anti-Gulping Dog Bowl, Ceramic Look', 15.49, 4.1, 5420, 1500, 70],
    ['Petmate', 'Fun Feeder Ceramic Slow Feeder, Dishwasher Safe', 21.99, 4.5, 3301, 1200, 150],
    ['LePet', 'Silicone Slow Feeder Mat with Suction Cups', 8.49, 4, 2102, 950, 40],
    ['Kong', 'Slow Feed Bowl Large, Durable Rubber', 24.99, 4.6, 7788, 900, null],
    ['Loving Pets', 'Bella Spill-Proof Slow Feeder Bowl', 16.99, 4.3, 1840, 620, 20],
    ['Mr. Peanut', 'Stainless Slow Feeder Insert for Dog Bowls', 14.49, 4.2, 960, 410, 8],
    ['Gorilla Grip', 'Silicone Slow Feeder Bowl, Collapsible', 10.99, 3.9, 640, 280, 5],
  ]
  const products: FixtureProduct[] = base.map(
    ([brand, title, price, rating, reviews, sales, ago], i) => ({
      platformId: `B0FX${suffix.slice(0, 4).toUpperCase()}${pad(i)}`,
      title,
      brand,
      listedAt: ago === null ? null : daysAgo(now, ago),
      price,
      rating,
      reviewCount: reviews,
      sales: SEASON.map((f, k) => Math.round(sales * f * (0.9 + (k % 3) * 0.05))),
      ...(i < 3 ? { altSales: Math.round(sales * 0.88) } : {}),
    }),
  )

  const observations: FixtureObservation[] = []
  for (const p of products) {
    const point = (
      metric: string,
      value: number,
      sourceId: string,
      method: FixtureObservation['method'],
      currency: string | null = null,
      observedOn = today,
    ) =>
      observations.push({
        platformId: p.platformId,
        entityType: 'product',
        metric,
        observedOn,
        sourceId,
        value,
        currency,
        method,
      })
    point('price', p.price, 'keepa', 'official', 'USD')
    point('rating', p.rating, 'keepa', 'official')
    point('review_count', p.reviewCount, 'keepa', 'official')
    p.sales.forEach((v, k) => {
      const month = monthAdd(y, m, k - 11)
      point(
        'sales_estimate_monthly',
        v,
        'jungle-scout',
        'estimate',
        null,
        k === 11 ? today : `${month}-01`,
      )
    })
    if (p.altSales)
      point('sales_estimate_monthly', p.altSales, 'sellersprite', 'estimate', null, today)
  }
  // 搜索量 24 个月，去年缺 3 个月（同比只用重叠的 9 个月）
  for (let k = 0; k < 24; k++) {
    if (k === 2 || k === 3 || k === 7) continue
    const month = monthAdd(y, m, k - 23)
    const season = SEASON[k % 12] ?? 1
    const value = Math.round((k < 12 ? 52_000 : 69_000) * season)
    observations.push({
      platformId: null,
      entityType: 'keyword',
      metric: 'search_volume_monthly',
      observedOn: `${month}-01`,
      sourceId: 'sellersprite',
      value,
      currency: null,
      method: 'estimate',
    })
  }

  const negatives: [number, number, string, string][] = [
    [
      0,
      2,
      'Slides all over the floor',
      'The bowl slides across the kitchen floor every meal, no grip on the bottom at all.',
    ],
    [
      0,
      1,
      'Cracked in a week',
      'Plastic cracked after one week, my lab chewed the edge. Material feels cheap.',
    ],
    [
      1,
      2,
      'Hard to clean',
      'The maze ridges are impossible to clean, food gets stuck in the corners.',
    ],
    [
      1,
      3,
      'Too small',
      'Way too small for a large breed, the kibble does not even fit. Size is wrong.',
    ],
    [2, 2, 'Smell', 'Strong chemical smell out of the box that never went away.'],
    [2, 1, 'Not dishwasher safe', 'Warped in the dishwasher, hard to clean by hand too.'],
    [3, 2, 'Slides and tips', 'Slides on tile, no grip, my dog pushes it around the room.'],
    [3, 3, 'Scratches', 'Stainless scratches easily and the rubber ring came off. Cheap material.'],
    [4, 1, 'Broke', 'Cracked within days, cheap plastic material. Sharp edges after it broke.'],
    [4, 2, 'Size', 'Too small and too shallow for a golden retriever.'],
    [5, 2, 'Color', 'Color is different from the photos, looks faded.'],
    [5, 3, 'Clean', 'Hard to clean the ridges, gets slimy.'],
    [6, 2, 'Slides', 'Slides around unless I hold it, no grip on the base.'],
    [7, 1, 'Suction fails', 'Suction cups do not hold, it slides off the floor immediately.'],
    [8, 3, 'Heavy', 'Too heavy and smells like rubber for weeks.'],
    [9, 2, 'Packaging', 'Arrived cracked, packaging was just a thin bag.'],
  ]
  const reviews: FixtureReview[] = negatives.map(([pi, rating, title, body], i) => ({
    platformId: products[pi]?.platformId as string,
    reviewId: `R${suffix}-${i}`,
    rating,
    title,
    body,
    reviewedOn: daysAgo(now, 5 + i * 3).slice(0, 10),
  }))
  for (let i = 0; i < 6; i++)
    reviews.push({
      platformId: products[i]?.platformId as string,
      reviewId: `R${suffix}-p${i}`,
      rating: 5,
      title: 'Great',
      body: 'My dog eats slower now, works as described.',
      reviewedOn: daysAgo(now, 2 + i).slice(0, 10),
    })

  return { categoryId, keyword, products, observations, reviews }
}
