import {
  brandEntry,
  cluster,
  clusterMember,
  clusterSignal,
  costingScenario,
  costParam,
  createDb,
  type Database,
  decision,
  direction,
  directionSeller,
  lead,
  leadEvent,
  logisticsProfile,
  marketplaceProduct,
  observation,
  organization,
  readinessStat,
  recommendation,
  riskFinding,
  scoped,
  scoringSetting,
  seasonalNode,
  supplier,
  supplierQuote,
  weightSuggestion,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll } from 'vitest'

/** 只在隔离的 worktree / CI 数据库上运行（vitest.config.ts 设置） */
export const url = process.env.FOLLOW_TEST_DATABASE_URL

export function testDb(): Database {
  // 未配置时用占位地址（postgres.js 惰性连接，不会真正连库）
  const db = createDb(url ?? 'postgres://skip@127.0.0.1:1/skip')
  afterAll(() => db.$client.end())
  return db
}

export async function createWorkspace(db: Database, name: string): Promise<string> {
  const id = newId()
  await db
    .insert(organization)
    .values({ id, name, slug: `${name.toLowerCase()}-${id.slice(-10)}`, isPersonal: false })
  return id
}

export interface ProductInput {
  readonly marketplace: string
  readonly platformId: string
  readonly title: string
  readonly categoryId?: string
  readonly sellerId?: string
  readonly brand?: string
  readonly gtin?: string
  readonly listedOn?: string
  readonly firstSeenOn: string
}

export async function insertProduct(db: Database, input: ProductInput): Promise<string> {
  const [row] = await db
    .insert(marketplaceProduct)
    .values({
      marketplace: input.marketplace,
      platformId: input.platformId,
      title: input.title,
      sellerId: input.sellerId,
      brand: input.brand,
      gtin: input.gtin,
      categoryId: input.categoryId,
      listedAt: input.listedOn ? new Date(`${input.listedOn}T00:00:00Z`) : null,
      firstSeenAt: new Date(`${input.firstSeenOn}T00:00:00Z`),
    })
    .returning({ id: marketplaceProduct.id })
  return row?.id as string
}

export interface Obs {
  readonly entityId: string
  readonly metric: string
  readonly observedOn: string
  readonly value: number
  readonly sourceId?: string
}

export async function observe(db: Database, rows: readonly Obs[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(observation).values(
      rows.slice(i, i + 500).map((r) => ({
        entityType: 'product' as const,
        entityId: r.entityId,
        metric: r.metric,
        observedOn: r.observedOn,
        sourceId: r.sourceId ?? 'ebay-browse',
        value: r.value,
        method: 'official' as const,
        tier: 1,
        fetchedAt: new Date(`${r.observedOn}T01:00:00Z`),
      })),
    )
  }
}

/**
 * 按外键顺序清理一个测试空间及其商品（市场商品与观测是部署级共享表）：
 * 推荐 → 决定 → 线索（级联核算组合与事件）→ 报价 → 簇 → 方向；最后删商品与空间。
 */
export async function cleanup(db: Database, workspaceId: string, productIds: readonly string[]) {
  const s = scoped(db, workspaceId)
  await s.delete(recommendation, undefined)
  await s.delete(readinessStat, undefined)
  await s.delete(weightSuggestion, undefined)
  await s.delete(decision, undefined)
  await s.delete(costingScenario, undefined)
  await s.delete(leadEvent, undefined)
  await s.delete(lead, undefined)
  await s.delete(supplierQuote, undefined)
  await s.delete(supplier, undefined)
  await s.delete(logisticsProfile, undefined)
  await s.delete(costParam, undefined)
  await s.delete(riskFinding, undefined)
  await s.delete(clusterSignal, undefined)
  await s.delete(clusterMember, undefined)
  await s.delete(cluster, undefined)
  await s.delete(directionSeller, undefined)
  await s.delete(direction, undefined)
  await s.delete(seasonalNode, undefined)
  await s.delete(brandEntry, undefined)
  await s.delete(scoringSetting, undefined)
  if (productIds.length > 0) {
    await db.delete(observation).where(inArray(observation.entityId, [...productIds]))
    await db.delete(marketplaceProduct).where(inArray(marketplaceProduct.id, [...productIds]))
  }
  await db.delete(organization).where(eq(organization.id, workspaceId))
}
