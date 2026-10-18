import type { Marketplace } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { marketplaceCategory } from '@product-res/db/schema'
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm'

export interface CategoryOption {
  readonly categoryId: string
  readonly name: string
  readonly path: string
  readonly leaf: boolean
}

/** 转义 LIKE 通配符，用户输入按字面匹配 */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

/**
 * 按名称（或类目 ID）搜索站点类目，用于方向配置的类目选择。
 * 叶子类目排在前面，其次按名称；没有类目数据时返回空数组，调用方保持手填。
 */
export async function searchCategories(
  db: Database,
  marketplace: Marketplace,
  query: string,
  limit = 20,
): Promise<CategoryOption[]> {
  const q = query.trim()
  if (!q) return []
  const pattern = likePattern(q)
  return db
    .select({
      categoryId: marketplaceCategory.categoryId,
      name: marketplaceCategory.name,
      path: marketplaceCategory.path,
      leaf: marketplaceCategory.leaf,
    })
    .from(marketplaceCategory)
    .where(
      and(
        eq(marketplaceCategory.marketplace, marketplace),
        or(ilike(marketplaceCategory.name, pattern), eq(marketplaceCategory.categoryId, q)),
      ),
    )
    .orderBy(sql`${marketplaceCategory.leaf} desc`, asc(marketplaceCategory.name))
    .limit(Math.min(Math.max(limit, 1), 50))
}
