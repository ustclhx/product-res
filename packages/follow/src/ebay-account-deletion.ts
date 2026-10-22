import {
  auditLog,
  type Database,
  directionSeller,
  leadEvent,
  marketplaceProduct,
  marketplaceSeller,
  observation,
  rawPayload,
  storeListing,
  syncRun,
  trackedStore,
} from '@product-res/db'
import { and, eq, inArray, like, type SQL, sql } from 'drizzle-orm'

/**
 * eBay 账号删除（openspec/changes/add-ebay-account-deletion design D3、D4）。
 *
 * 部署级合规操作：跨所有空间删除 / 匿名化某个 eBay 用户的数据，因此不经 scoped()。
 * 只按 eBay 用户名 / userId 过滤，且只触及 eBay 站点的数据。单事务完成，按 notificationId 去重：
 * 事务级 advisory lock 串行化同一通知的并发重发，已处理记录是只追加的 audit_log 行。
 */

export const EBAY_ACCOUNT_DELETION_ACTION = 'ebay.account_deletion'
const TARGET_TYPE = 'ebay-notification'

export interface EbayAccountDeletionInput {
  readonly notificationId: string
  /** 公开用户名；部分美国用户此字段可能是不可变 userId（官方文档 2025-09-26 起） */
  readonly username?: string | null
  readonly userId?: string | null
  readonly eventDate?: string | null
  readonly publishAttemptCount?: number | null
}

export interface EbayAccountDeletionCounts {
  trackedStores: number
  directionSellers: number
  storeListings: number
  sellers: number
  sellerObservations: number
  productsUnlinked: number
  leadEvents: number
  syncRuns: number
  rawPayloads: number
}

export interface EbayAccountDeletionResult {
  readonly status: 'processed' | 'duplicate'
  /** sha256hex('ebay:' + 小写用户名)；日志与审计只记录它，不记录明文 */
  readonly userHash: string
  readonly counts: EbayAccountDeletionCounts
}

const EMPTY: EbayAccountDeletionCounts = {
  trackedStores: 0,
  directionSellers: 0,
  storeListings: 0,
  sellers: 0,
  sellerObservations: 0,
  productsUnlinked: 0,
  leadEvents: 0,
  syncRuns: 0,
  rawPayloads: 0,
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 用户名与 userId 去空白、小写后去重；eBay 用户名不区分大小写 */
export function ebayUserKeys(input: Pick<EbayAccountDeletionInput, 'username' | 'userId'>) {
  const keys = [input.username, input.userId]
    .map((v) => v?.trim().toLowerCase() ?? '')
    .filter((v) => v.length > 0)
  return [...new Set(keys)]
}

export function ebayUserHash(input: Pick<EbayAccountDeletionInput, 'username' | 'userId'>) {
  return sha256Hex(`ebay:${ebayUserKeys(input)[0] ?? ''}`)
}

export async function deleteEbayUserData(
  db: Database,
  input: EbayAccountDeletionInput,
): Promise<EbayAccountDeletionResult> {
  const keys = ebayUserKeys(input)
  const userHash = await ebayUserHash(input)
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`ebay-account-deletion:${input.notificationId}`}))`,
    )
    const [seen] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, EBAY_ACCOUNT_DELETION_ACTION),
          eq(auditLog.targetType, TARGET_TYPE),
          eq(auditLog.targetId, input.notificationId),
        ),
      )
      .limit(1)
    if (seen) return { status: 'duplicate' as const, userHash, counts: { ...EMPTY } }

    const counts = { ...EMPTY }
    if (keys.length > 0) {
      const matches = (column: SQL | Parameters<typeof eq>[0]) =>
        inArray(sql`lower(${column})`, keys)
      const ebaySite = (column: Parameters<typeof like>[0]) => like(column, 'ebay-%')

      // 店铺池与对标店铺：所有空间直接删除（design D4：seller_key 非空且参与唯一键，不保留占位行）
      counts.trackedStores = (
        await tx
          .delete(trackedStore)
          .where(and(eq(trackedStore.platform, 'ebay'), matches(trackedStore.sellerKey)))
          .returning({ id: trackedStore.id })
      ).length
      counts.directionSellers = (
        await tx
          .delete(directionSeller)
          .where(
            and(ebaySite(directionSeller.marketplace), matches(directionSeller.sellerPlatformId)),
          )
          .returning({ id: directionSeller.id })
      ).length
      counts.storeListings = (
        await tx
          .delete(storeListing)
          .where(and(eq(storeListing.platform, 'ebay'), matches(storeListing.sellerKey)))
          .returning({ id: storeListing.id })
      ).length

      // 卖家实体与以它为实体的观测
      const sellers = await tx
        .select({ id: marketplaceSeller.id })
        .from(marketplaceSeller)
        .where(and(ebaySite(marketplaceSeller.marketplace), matches(marketplaceSeller.platformId)))
      const sellerIds = sellers.map((s) => s.id)
      if (sellerIds.length > 0) {
        counts.sellerObservations = (
          await tx
            .delete(observation)
            .where(
              and(eq(observation.entityType, 'seller'), inArray(observation.entityId, sellerIds)),
            )
            .returning({ id: observation.entityId })
        ).length
        counts.sellers = (
          await tx
            .delete(marketplaceSeller)
            .where(inArray(marketplaceSeller.id, sellerIds))
            .returning({ id: marketplaceSeller.id })
        ).length
      }

      // 商品是公开刊登数据，保留；只断开与该用户的关联
      counts.productsUnlinked = (
        await tx
          .update(marketplaceProduct)
          .set({ sellerId: null })
          .where(
            and(ebaySite(marketplaceProduct.marketplace), matches(marketplaceProduct.sellerId)),
          )
          .returning({ id: marketplaceProduct.id })
      ).length

      // jsonb 中的用户名：线索备注、同步范围、原始响应的任务范围与请求 URL
      counts.leadEvents = (
        await tx
          .update(leadEvent)
          .set({ payload: sql`${leadEvent.payload} - 'sellerKey'` })
          .where(matches(sql`${leadEvent.payload}->>'sellerKey'`))
          .returning({ id: leadEvent.id })
      ).length
      counts.syncRuns = (
        await tx
          .update(syncRun)
          .set({ scope: sql`${syncRun.scope} - 'sellerId'` })
          .where(and(ebaySite(syncRun.marketplace), matches(sql`${syncRun.scope}->>'sellerId'`)))
          .returning({ id: syncRun.id })
      ).length
      counts.rawPayloads = (
        await tx
          .update(rawPayload)
          .set({
            body: null,
            purgedAt: sql`coalesce(${rawPayload.purgedAt}, now())`,
            task: sql`${rawPayload.task} #- '{scope,sellerId}'`,
            request: sql`jsonb_set(${rawPayload.request}, '{url}', '"[redacted:ebay-account-deletion]"')`,
          })
          .where(
            and(
              like(sql`${rawPayload.task}->>'marketplace'`, 'ebay-%'),
              matches(sql`${rawPayload.task}->'scope'->>'sellerId'`),
            ),
          )
          .returning({ id: rawPayload.id })
      ).length
    }

    await tx.insert(auditLog).values({
      action: EBAY_ACCOUNT_DELETION_ACTION,
      targetType: TARGET_TYPE,
      targetId: input.notificationId,
      meta: {
        userHash,
        counts,
        eventDate: input.eventDate ?? null,
        publishAttemptCount: input.publishAttemptCount ?? null,
      },
    })
    return { status: 'processed' as const, userHash, counts }
  })
}
