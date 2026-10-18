import { creditGrant, creditLedger, payment } from '@product-res/db'
import { and, eq, lte, type SQL, sql } from 'drizzle-orm'
import {
  CreditsError,
  type CreditsExecutor,
  type CreditsTransaction,
  lockWorkspaceCredits,
  withCreditsTransaction,
} from './index.ts'

/** Cancel only unreserved credits; outstanding allocations settle through capture/release. */
async function cancelGrants(
  tx: CreditsTransaction,
  workspaceId: string,
  status: 'expired' | 'revoked',
  predicate?: SQL,
) {
  const grants = await tx
    .select()
    .from(creditGrant)
    .where(
      and(eq(creditGrant.workspaceId, workspaceId), eq(creditGrant.status, 'active'), predicate),
    )
    .for('update')
  let canceled = 0
  for (const grant of grants) {
    await tx
      .update(creditGrant)
      .set({ remaining: 0, status })
      .where(and(eq(creditGrant.workspaceId, workspaceId), eq(creditGrant.id, grant.id)))
    if (grant.remaining > 0) {
      await tx.insert(creditLedger).values({
        workspaceId,
        grantId: grant.id,
        type: status === 'expired' ? 'expire' : 'revoke',
        delta: -grant.remaining,
      })
    }
    canceled += grant.remaining
  }
  return { grants: grants.length, canceled }
}

/** Marks elapsed active grants expired, including fully reserved/consumed grants. */
export async function expireWorkspaceCredits(
  db: CreditsExecutor,
  workspaceId: string,
  tx?: CreditsTransaction,
  now?: Date,
) {
  if (now && !Number.isFinite(now.getTime())) throw new Error('Invalid credit expiration time')
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId)
    return cancelGrants(tx, workspaceId, 'expired', lte(creditGrant.expiresAt, now ?? sql`now()`))
  })
}

export interface RevokePaymentCreditsInput {
  workspaceId: string
  paymentId: string
}

/** 收回指定空间的单一批次；预扣分配仍由 capture / release 结算，不会复活。 */
export async function revokeGrant(
  db: CreditsExecutor,
  input: { workspaceId: string; grantId: string },
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: creditGrant.id })
      .from(creditGrant)
      .where(and(eq(creditGrant.workspaceId, input.workspaceId), eq(creditGrant.id, input.grantId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    return cancelGrants(tx, input.workspaceId, 'revoked', eq(creditGrant.id, input.grantId))
  })
}

/** Covers every linked monthly grant already present, without chasing consumed credits. */
export async function revokePaymentCredits(
  db: CreditsExecutor,
  input: RevokePaymentCreditsInput,
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: payment.id })
      .from(payment)
      .where(and(eq(payment.workspaceId, input.workspaceId), eq(payment.id, input.paymentId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    return cancelGrants(
      tx,
      input.workspaceId,
      'revoked',
      eq(creditGrant.paymentId, input.paymentId),
    )
  })
}

/** 未退款份额，用于部分退款按比例保留积分。 */
export interface PaymentKeptShare {
  /** 付款金额减累计退款（最小货币单位） */
  readonly kept: number
  /** 付款金额（最小货币单位） */
  readonly total: number
}

/** 每个批次按未退款份额向下取整保留：`floor(amount × kept / total)`。 */
export function keptCredits(amount: number, share: PaymentKeptShare) {
  if (
    !Number.isInteger(share.kept) ||
    !Number.isInteger(share.total) ||
    share.total <= 0 ||
    share.kept < 0 ||
    share.kept > share.total
  )
    throw new Error('Invalid payment kept share')
  return Math.floor((amount * share.kept) / share.total)
}

/**
 * 部分退款：付款下每个 active 批次只保留未退款份额，超出部分从剩余积分中收回（`type='revoke'`）。
 * 已消费与被预扣占用的部分不追溯（Q6）；按批次已收回总量计算目标，同一退款重放或多次部分退款都不会重复收回。
 * 全额退款与争议仍走 `revokePaymentCredits`。
 */
export async function reducePaymentCredits(
  db: CreditsExecutor,
  input: RevokePaymentCreditsInput & { share: PaymentKeptShare },
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: payment.id })
      .from(payment)
      .where(and(eq(payment.workspaceId, input.workspaceId), eq(payment.id, input.paymentId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    const grants = await tx
      .select()
      .from(creditGrant)
      .where(
        and(
          eq(creditGrant.workspaceId, input.workspaceId),
          eq(creditGrant.paymentId, input.paymentId),
          eq(creditGrant.status, 'active'),
        ),
      )
      .for('update')
    let revoked = 0
    for (const batch of grants) {
      const [prior] = await tx
        .select({ total: sql<number>`coalesce(-sum(${creditLedger.delta}), 0)::int` })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.workspaceId, input.workspaceId),
            eq(creditLedger.grantId, batch.id),
            eq(creditLedger.type, 'revoke'),
          ),
        )
      const target = batch.amount - keptCredits(batch.amount, input.share)
      const delta = Math.min(batch.remaining, Math.max(0, target - (prior?.total ?? 0)))
      if (delta === 0) continue
      await tx
        .update(creditGrant)
        .set({ remaining: batch.remaining - delta })
        .where(and(eq(creditGrant.workspaceId, input.workspaceId), eq(creditGrant.id, batch.id)))
      await tx.insert(creditLedger).values({
        workspaceId: input.workspaceId,
        grantId: batch.id,
        type: 'revoke',
        delta: -delta,
      })
      revoked += delta
    }
    return { grants: grants.length, revoked }
  })
}

/** Deletion prerequisite: cancel all active grants, preserving holds and existing debt. */
export async function revokeWorkspaceCredits(
  db: CreditsExecutor,
  workspaceId: string,
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId)
    return cancelGrants(tx, workspaceId, 'revoked')
  })
}
