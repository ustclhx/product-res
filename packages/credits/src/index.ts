import { type TemplateConfig, templateConfigDefaults } from '@product-res/config'
import {
  type CreditGrant,
  type CreditHold,
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  type Database,
  member,
  payment,
} from '@product-res/db'
import { and, asc, eq, gt, is, isNull, or, sql } from 'drizzle-orm'
import { PgTransaction } from 'drizzle-orm/pg-core'

export type CreditsTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** A database opens its own transaction; a transaction is joined directly. */
export type CreditsExecutor = Database | CreditsTransaction
export type CreditsErrorCode =
  | 'INVALID_CREDIT_AMOUNT'
  | 'SOURCE_ALREADY_GRANTED'
  | 'CREDIT_DEBT'
  | 'INSUFFICIENT_CREDITS'
  | 'WORKSPACE_RESOURCE_NOT_FOUND'
  | 'HOLD_NOT_ACTIVE'
  | 'INVALID_OVERAGE_POLICY'

export class CreditsError extends Error {
  readonly code: CreditsErrorCode

  constructor(code: CreditsErrorCode) {
    super(code)
    this.code = code
    this.name = 'CreditsError'
  }
}

function validateAmount(amount: number) {
  // Credit columns are PostgreSQL int4, in addition to the JS safe-integer boundary.
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
    throw new CreditsError('INVALID_CREDIT_AMOUNT')
  }
}

/** All credit mutations (including settlement) must acquire this lock first. */
export async function lockWorkspaceCredits(tx: CreditsTransaction, workspaceId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${workspaceId}`}, 0))`,
  )
}

function isCreditsTransaction(db: CreditsExecutor): db is CreditsTransaction {
  return is(db, PgTransaction)
}

/**
 * A supplied transaction (explicit `tx`, or `db` itself) participates directly,
 * without a savepoint; its caller owns commit/rollback.
 */
export async function withCreditsTransaction<T>(
  db: CreditsExecutor,
  tx: CreditsTransaction | undefined,
  operation: (tx: CreditsTransaction) => Promise<T>,
): Promise<T> {
  const joined = tx ?? (isCreditsTransaction(db) ? db : undefined)
  return joined ? operation(joined) : db.transaction(operation)
}

export interface GrantInput {
  workspaceId: string
  source: CreditGrant['source']
  sourceRef: string
  amount: number
  paymentId?: string | null
  expiresAt?: Date | null
}

/** Replays return the existing workspace-owned grant without changing debt or ledger. */
export async function grant(
  db: CreditsExecutor,
  input: GrantInput,
  tx?: CreditsTransaction,
): Promise<CreditGrant> {
  validateAmount(input.amount)
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const sameSource = and(
      eq(creditGrant.workspaceId, input.workspaceId),
      eq(creditGrant.source, input.source),
      eq(creditGrant.sourceRef, input.sourceRef),
    )
    const [existing] = await tx.select().from(creditGrant).where(sameSource)
    if (existing) return existing
    if (input.paymentId) {
      const [owned] = await tx
        .select({ id: payment.id })
        .from(payment)
        .where(and(eq(payment.id, input.paymentId), eq(payment.workspaceId, input.workspaceId)))
      if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    }
    // Claim the global (source, source_ref) key BEFORE touching debt. ON CONFLICT
    // handles concurrent grants in different workspaces without aborting tx.
    const [created] = await tx
      .insert(creditGrant)
      .values({ ...input, remaining: input.amount })
      .onConflictDoNothing({ target: [creditGrant.source, creditGrant.sourceRef] })
      .returning()
    if (!created) {
      const [replay] = await tx.select().from(creditGrant).where(sameSource)
      if (replay) return replay
      // Never return the grant (or workspace ID) belonging to another workspace.
      throw new CreditsError('SOURCE_ALREADY_GRANTED')
    }
    const [debt] = await tx
      .select()
      .from(creditDebt)
      .where(eq(creditDebt.workspaceId, input.workspaceId))
      .for('update')
    const repaid = Math.min(debt?.amount ?? 0, input.amount)
    let result = created
    if (repaid > 0) {
      await tx
        .update(creditDebt)
        .set({ amount: (debt?.amount ?? 0) - repaid })
        .where(eq(creditDebt.workspaceId, input.workspaceId))
      const [updated] = await tx
        .update(creditGrant)
        .set({ remaining: input.amount - repaid })
        .where(and(eq(creditGrant.id, created.id), eq(creditGrant.workspaceId, input.workspaceId)))
        .returning()
      if (!updated) throw new Error('Inserted credit grant disappeared')
      result = updated
    }
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      grantId: created.id,
      type: 'grant',
      delta: input.amount,
      refType: input.source,
      refId: input.sourceRef,
    })
    if (repaid > 0) {
      await tx.insert(creditLedger).values({
        workspaceId: input.workspaceId,
        grantId: created.id,
        type: 'debt_repay',
        delta: 0,
        note: `Repaid ${repaid} credits of debt`,
      })
    }
    return result
  })
}

export interface HoldInput {
  workspaceId: string
  userId: string
  amount: number
  refType: CreditHold['refType']
  refId: string
  expiresAt?: Date | null
}

export async function hold(
  db: CreditsExecutor,
  input: HoldInput,
  tx?: CreditsTransaction,
): Promise<CreditHold> {
  validateAmount(input.amount)
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, input.workspaceId), eq(member.userId, input.userId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    const [debt] = await tx
      .select({ amount: creditDebt.amount })
      .from(creditDebt)
      .where(eq(creditDebt.workspaceId, input.workspaceId))
    if (debt && debt.amount > 0) throw new CreditsError('CREDIT_DEBT')
    const batches = await tx
      .select()
      .from(creditGrant)
      .where(
        and(
          eq(creditGrant.workspaceId, input.workspaceId),
          eq(creditGrant.status, 'active'),
          gt(creditGrant.remaining, 0),
          or(isNull(creditGrant.expiresAt), gt(creditGrant.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(
        sql`${creditGrant.expiresAt} asc nulls last`,
        asc(creditGrant.createdAt),
        asc(creditGrant.id),
      )
      .for('update')
    // Check before any mutation, including when an external caller catches errors.
    if (batches.reduce((total, batch) => total + batch.remaining, 0) < input.amount) {
      throw new CreditsError('INSUFFICIENT_CREDITS')
    }
    const [created] = await tx.insert(creditHold).values(input).returning()
    if (!created) throw new Error('Credit hold insert returned no row')
    let needed = input.amount
    for (const batch of batches) {
      if (needed === 0) break
      const amount = Math.min(needed, batch.remaining)
      await tx
        .update(creditGrant)
        .set({ remaining: batch.remaining - amount })
        .where(and(eq(creditGrant.id, batch.id), eq(creditGrant.workspaceId, input.workspaceId)))
      await tx
        .insert(creditHoldAllocation)
        .values({ holdId: created.id, grantId: batch.id, amount })
      needed -= amount
    }
    // Held credits remain in the reconciliation invariant; consume is settlement-only.
    return created
  })
}

export interface ReleaseInput {
  workspaceId: string
  holdId: string
}

export type OveragePolicy = TemplateConfig['billing']['overage']

export interface CaptureInput extends ReleaseInput {
  actualAmount: number
  overage?: Partial<OveragePolicy>
}

export interface CaptureResult {
  captured: number
  absorbed: number
  debited: number
  debt: number
}

/** Settle once, preserving the original allocations as an audit trail. */
async function settle(
  tx: CreditsTransaction,
  input: ReleaseInput,
  actualAmount: number | undefined,
  policy: OveragePolicy = templateConfigDefaults.billing.overage,
): Promise<CaptureResult> {
  await lockWorkspaceCredits(tx, input.workspaceId)
  const ownedHold = and(
    eq(creditHold.id, input.holdId),
    eq(creditHold.workspaceId, input.workspaceId),
  )
  const [reservation] = await tx.select().from(creditHold).where(ownedHold)
  if (!reservation) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
  if (reservation.status !== 'held') throw new CreditsError('HOLD_NOT_ACTIVE')
  const captured = Math.min(actualAmount ?? 0, reservation.amount)
  const excess = Math.max(0, (actualAmount ?? 0) - reservation.amount)
  // SQL now() is stable for the transaction: UTC budget boundaries and the
  // settlement timestamp use the same date even across a midnight wait.
  const dayStart = sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`
  const [daily] =
    excess > 0
      ? await tx
          .select({ amount: sql<number>`coalesce(sum(${creditHold.overageAbsorbed}), 0)::float8` })
          .from(creditHold)
          .where(
            and(
              eq(creditHold.workspaceId, input.workspaceId),
              eq(creditHold.status, 'captured'),
              sql`${creditHold.updatedAt} >= ${dayStart}`,
              sql`${creditHold.updatedAt} < ${dayStart} + interval '24 hours'`,
            ),
          )
      : []
  const absorbed = Math.min(
    excess,
    Math.floor(Math.min(reservation.amount * policy.maxRatio, policy.maxCredits)),
    Math.max(0, policy.dailyBudgetPerWorkspace - (daily?.amount ?? 0)),
  )
  const supplemental =
    excess > absorbed
      ? await tx
          .select({
            grant: creditGrant,
            expired: sql<boolean>`${creditGrant.expiresAt} is not null and ${creditGrant.expiresAt} <= now()`,
          })
          .from(creditGrant)
          .where(
            and(
              eq(creditGrant.workspaceId, input.workspaceId),
              eq(creditGrant.status, 'active'),
              gt(creditGrant.remaining, 0),
            ),
          )
          .orderBy(
            sql`${creditGrant.expiresAt} asc nulls last`,
            asc(creditGrant.createdAt),
            asc(creditGrant.id),
          )
          .for('update')
      : []
  const debited = Math.min(
    excess - absorbed,
    supplemental.filter((b) => !b.expired).reduce((total, b) => total + b.grant.remaining, 0),
  )
  const debt = excess - absorbed - debited
  const [existingDebt] =
    debt > 0
      ? await tx
          .select()
          .from(creditDebt)
          .where(eq(creditDebt.workspaceId, input.workspaceId))
          .for('update')
      : []
  // Check int4 bounds before the state gate, including for caller-owned txs.
  if ((existingDebt?.amount ?? 0) + debt > 2_147_483_647) {
    throw new CreditsError('INVALID_CREDIT_AMOUNT')
  }
  const allocations = await tx
    .select({
      grant: creditGrant,
      amount: creditHoldAllocation.amount,
      expired: sql<boolean>`${creditGrant.expiresAt} is not null and ${creditGrant.expiresAt} <= now()`,
    })
    .from(creditHoldAllocation)
    .innerJoin(creditGrant, eq(creditGrant.id, creditHoldAllocation.grantId))
    .where(
      and(
        eq(creditHoldAllocation.holdId, reservation.id),
        eq(creditGrant.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(
      sql`${creditGrant.expiresAt} asc nulls last`,
      asc(creditGrant.createdAt),
      asc(creditGrant.id),
    )
    .for('update', { of: creditGrant })

  // The first mutation is the state gate; all plans and validation precede it.
  const [settled] = await tx
    .update(creditHold)
    .set({
      status: actualAmount === undefined ? 'released' : 'captured',
      capturedAmount: captured,
      overageAbsorbed: absorbed,
      overageDebited: debited,
      overageDebt: debt,
      updatedAt: sql`now()`,
    })
    .where(and(ownedHold, eq(creditHold.status, 'held')))
    .returning()
  if (!settled) throw new CreditsError('HOLD_NOT_ACTIVE')

  let toConsume = captured
  for (const allocation of allocations) {
    const batch = allocation.grant
    const consumed = Math.min(toConsume, allocation.amount)
    const returned = allocation.amount - consumed
    toConsume -= consumed
    const batchScope = and(
      eq(creditGrant.id, batch.id),
      eq(creditGrant.workspaceId, input.workspaceId),
    )
    const invalid = batch.status !== 'active' || allocation.expired
    // Expiry cron may not have run yet. Cancel the unreserved remainder once
    // and mark expired so later settlements/cron cannot expire it again.
    if (batch.status === 'active' && allocation.expired) {
      await tx.update(creditGrant).set({ remaining: 0, status: 'expired' }).where(batchScope)
      if (batch.remaining > 0) {
        await tx.insert(creditLedger).values({
          workspaceId: input.workspaceId,
          grantId: batch.id,
          type: 'expire',
          delta: -batch.remaining,
        })
      }
    }
    if (returned === 0) continue
    if (invalid) {
      await tx.insert(creditLedger).values({
        workspaceId: input.workspaceId,
        userId: settled.userId,
        grantId: batch.id,
        type: batch.status === 'revoked' ? 'revoke' : 'expire',
        delta: -returned,
        refType: settled.refType,
        refId: settled.refId,
      })
    } else {
      await tx
        .update(creditGrant)
        .set({ remaining: batch.remaining + returned })
        .where(batchScope)
    }
  }
  let toDebit = debited
  const allocatedIds = new Set(allocations.map((a) => a.grant.id))
  for (const item of supplemental) {
    const batch = item.grant
    const batchScope = and(
      eq(creditGrant.id, batch.id),
      eq(creditGrant.workspaceId, input.workspaceId),
    )
    if (item.expired) {
      // Allocated expired batches were already canceled by the loop above.
      if (!allocatedIds.has(batch.id)) {
        await tx.update(creditGrant).set({ remaining: 0, status: 'expired' }).where(batchScope)
        await tx.insert(creditLedger).values({
          workspaceId: input.workspaceId,
          grantId: batch.id,
          type: 'expire',
          delta: -batch.remaining,
        })
      }
      continue
    }
    const amount = Math.min(toDebit, batch.remaining)
    if (amount > 0) {
      await tx
        .update(creditGrant)
        .set({ remaining: batch.remaining - amount })
        .where(batchScope)
      toDebit -= amount
    }
  }
  if (debt > 0) {
    await tx
      .insert(creditDebt)
      .values({ workspaceId: input.workspaceId, amount: debt })
      .onConflictDoUpdate({
        target: creditDebt.workspaceId,
        set: { amount: sql`${creditDebt.amount} + ${debt}` },
      })
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      userId: settled.userId,
      type: 'debt',
      delta: -debt,
      refType: settled.refType,
      refId: settled.refId,
    })
  }
  if (actualAmount !== undefined) {
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      userId: settled.userId,
      type: 'consume',
      delta: -(captured + debited),
      refType: settled.refType,
      refId: settled.refId,
    })
  }
  return { captured, absorbed, debited, debt }
}

/** Capture held credits, absorb limited overage, then debit balance or record debt. */
export async function capture(
  db: CreditsExecutor,
  input: CaptureInput,
  tx?: CreditsTransaction,
): Promise<CaptureResult> {
  if (
    !Number.isSafeInteger(input.actualAmount) ||
    input.actualAmount < 0 ||
    input.actualAmount > 2_147_483_647
  ) {
    throw new CreditsError('INVALID_CREDIT_AMOUNT')
  }
  const policy = { ...templateConfigDefaults.billing.overage, ...input.overage }
  if (
    !Number.isFinite(policy.maxRatio) ||
    policy.maxRatio < 0 ||
    ![policy.maxCredits, policy.dailyBudgetPerWorkspace].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647,
    )
  ) {
    throw new CreditsError('INVALID_OVERAGE_POLICY')
  }
  return withCreditsTransaction(db, tx, (tx) => settle(tx, input, input.actualAmount, policy))
}

/** Release the full reservation without consuming credits. */
export async function release(
  db: CreditsExecutor,
  input: ReleaseInput,
  tx?: CreditsTransaction,
): Promise<void> {
  await withCreditsTransaction(db, tx, (tx) => settle(tx, input, undefined))
}

export * from './lifecycle.ts'
export * from './queries.ts'
