import { createMockConnector, type NormalizedCategory } from '@product-res/datasources'
import { dataSource, marketplaceCategory } from '@product-res/db/schema'
import { eq, like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDbArchive, runSyncTask, searchCategories } from '../src/index.ts'
import { context, integration, testDb, uniqueId } from './helpers.ts'

const now = new Date('2026-10-19T00:00:00Z')

describe.skipIf(!integration)('类目树同步与搜索（真实 Postgres）', () => {
  const db = testDb()
  const archive = createDbArchive(db)
  const tag = uniqueId('cat')
  const category = (
    id: string,
    name: string,
    parentId: string | null,
    leaf: boolean,
  ): NormalizedCategory => ({
    marketplace: 'ebay-us',
    categoryId: `${tag}-${id}`,
    name: `${name} ${tag}`,
    parentId: parentId ? `${tag}-${parentId}` : null,
    leaf,
    path: `${name} ${tag}`,
    treeVersion: '131',
  })

  it('taxonomy 同步写入类目，重复同步覆盖而不重复，方向页搜索可查到', async () => {
    const base = createMockConnector({ id: uniqueId('mock') })
    let categories = [
      category('1', 'Garden', null, false),
      category('2', 'Seat Organizer', '1', true),
    ]
    const connector = {
      ...base,
      capabilities: ['taxonomy' as const],
      plan: () => 2,
      normalize: () => ({ entities: [], observations: [], categories }),
    }
    await db.insert(dataSource).values({ id: connector.id, enabled: true })
    const task = { kind: 'taxonomy' as const, marketplace: 'ebay-us' as const, scope: {} }
    const run = () =>
      runSyncTask({ db, archive, ctx: context(now) }, connector, task, {
        mode: 'scheduled',
        trigger: 'scheduled',
      })
    expect(await run()).toMatchObject({ status: 'succeeded', observations: 2 })

    const found = await searchCategories(db, 'ebay-us', `seat organizer ${tag}`)
    expect(found).toEqual([
      {
        categoryId: `${tag}-2`,
        name: `Seat Organizer ${tag}`,
        path: `Seat Organizer ${tag}`,
        leaf: true,
      },
    ])
    // 按类目 ID 精确查找；别的站点没有数据
    expect(await searchCategories(db, 'ebay-us', `${tag}-1`)).toHaveLength(1)
    expect(await searchCategories(db, 'amazon-us', `seat organizer ${tag}`)).toEqual([])
    // 通配符按字面匹配
    expect(await searchCategories(db, 'ebay-us', '%')).toEqual([])

    // 第二次同步：改名并更新叶子标记，行数不变
    categories = [category('1', 'Yard', null, true), category('2', 'Seat Organizer', '1', true)]
    await run()
    const rows = await db
      .select()
      .from(marketplaceCategory)
      .where(eq(marketplaceCategory.marketplace, 'ebay-us'))
    const ours = rows.filter((r) => r.categoryId.startsWith(tag))
    expect(ours).toHaveLength(2)
    expect(ours.find((r) => r.categoryId === `${tag}-1`)).toMatchObject({
      name: `Yard ${tag}`,
      leaf: true,
    })
    await db.delete(marketplaceCategory).where(like(marketplaceCategory.categoryId, `${tag}%`))
  })
})
