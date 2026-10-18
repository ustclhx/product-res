import { env } from 'cloudflare:workers'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  categoryStudy,
  categoryStudySnapshot,
  createDb,
  marketplaceProduct,
  marketplaceReview,
  organization,
  scoped,
} from '../src/index.ts'

// add-category-insight 2.1：研究 / 快照为空间级，评论为部署级且商品 × 评论 ID 唯一。
const open = () => createDb(env.HYPERDRIVE)

async function seed(label: string) {
  const db = open()
  const wsId = newId()
  await db
    .insert(organization)
    .values({ id: wsId, name: label, slug: `i-${wsId.slice(-12)}`, isPersonal: false })
  const s = scoped(db, wsId)
  const [study] = await s
    .insert(categoryStudy, { name: `${label} 研究`, marketplace: 'amazon-us' })
    .returning()
  if (!study) throw new Error('seed failed')
  await s.insert(categoryStudySnapshot, { studyId: study.id, modules: { overview: {} } })
  return { wsId, studyId: study.id }
}

describe('品类洞察表', () => {
  let a: Awaited<ReturnType<typeof seed>>
  let b: Awaited<ReturnType<typeof seed>>
  const productId = newId()
  beforeAll(async () => {
    a = await seed('IA')
    b = await seed('IB')
    await open()
      .insert(marketplaceProduct)
      .values({ id: productId, marketplace: 'amazon-us', platformId: `B0${productId.slice(-8)}` })
  })
  afterAll(async () => {
    const db = open()
    await db.delete(marketplaceReview).where(eq(marketplaceReview.productId, productId))
    await db.delete(marketplaceProduct).where(eq(marketplaceProduct.id, productId))
    for (const ws of [a.wsId, b.wsId]) {
      await scoped(db, ws).delete(categoryStudySnapshot, undefined)
      await scoped(db, ws).delete(categoryStudy, undefined)
    }
    await db.delete(organization).where(inArray(organization.id, [a.wsId, b.wsId]))
  })

  it('研究与快照经 scoped() 跨空间隔离', async () => {
    const s = scoped(open(), a.wsId)
    expect((await s.select(categoryStudy)).map((r) => r.id)).toEqual([a.studyId])
    expect(await s.count(categoryStudySnapshot)).toBe(1)
    await expect(s.findById(categoryStudy, b.studyId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('同一商品的同一评论 ID 只能写入一次，评分限定 1–5', async () => {
    const db = open()
    const row = { productId, reviewId: 'R1', rating: 2, sourceId: 'import' }
    await db.insert(marketplaceReview).values(row)
    await expect(db.insert(marketplaceReview).values(row)).rejects.toThrow()
    await expect(
      db.insert(marketplaceReview).values({ ...row, reviewId: 'R2', rating: 6 }),
    ).rejects.toThrow()
  })
})
