import type { Database } from '@product-res/db'
import { scoped } from '@product-res/db'
import { type TrackedProductTier, trackedProduct } from '@product-res/db/schema'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'

/**
 * 被追踪商品（tracked_product，空间级）的最小读写（add-accuracy-store-tracking tasks 1.1）。
 * 调度、升降档规则与店铺新品由店铺追踪（tasks 3.x）实现；这里只保证“同一空间同一商品一行”
 * 和“档位变更必有原因”。
 */

export interface TrackProductInput {
  readonly productId: string
  readonly origin: 'store' | 'lead' | 'manual'
  /** tracked_store.id / lead.id；人工加入为空 */
  readonly originRef?: string | null
  /** 默认 normal */
  readonly tier?: TrackedProductTier
  readonly reason?: string
}

/** 加入追踪；已在追踪中的商品保持原档位与来源，返回现有行 */
export async function trackProduct(db: Database, workspaceId: string, input: TrackProductInput) {
  const s = scoped(db, workspaceId)
  const [created] = await s
    .insert(trackedProduct, {
      productId: input.productId,
      origin: input.origin,
      originRef: input.originRef ?? null,
      tier: input.tier ?? 'normal',
      tierReason: input.reason ?? `added:${input.origin}`,
    })
    .onConflictDoNothing()
    .returning()
  if (created) return { row: created, created: true }
  const [existing] = await s.select(trackedProduct, {
    where: eq(trackedProduct.productId, input.productId),
  })
  return { row: existing as typeof trackedProduct.$inferSelect, created: false }
}

/** 变更档位并记录原因；档位未变化或商品未在追踪中时不改动，返回 undefined */
export async function setTrackedProductTier(
  db: Database,
  workspaceId: string,
  input: {
    readonly productId: string
    readonly tier: TrackedProductTier
    readonly reason: string
    readonly now: Date
  },
) {
  const [row] = await scoped(db, workspaceId)
    .update(
      trackedProduct,
      { tier: input.tier, tierReason: input.reason, tierChangedAt: input.now },
      and(eq(trackedProduct.productId, input.productId), ne(trackedProduct.tier, input.tier)),
    )
    .returning()
  return row
}

/** 本空间的被追踪商品，可按档位过滤 */
export async function listTrackedProducts(
  db: Database,
  workspaceId: string,
  options: { readonly tiers?: readonly TrackedProductTier[] } = {},
) {
  return scoped(db, workspaceId)
    .select(trackedProduct, {
      ...(options.tiers ? { where: inArray(trackedProduct.tier, [...options.tiers]) } : {}),
    })
    .orderBy(asc(trackedProduct.createdAt))
}
