import { creditDebt, creditGrant, creditHold, creditLedger } from '@product-res/db'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import {
  type CreditsExecutor,
  type CreditsTransaction,
  lockWorkspaceCredits,
  withCreditsTransaction,
} from './index.ts'

export interface CreditCursor {
  /** Exact PostgreSQL timestamp, including microseconds, to avoid dropping tied rows. */
  createdAt: string
  id: string
}

export interface CreditPageInput {
  limit?: number
  cursor?: CreditCursor
}

function validatePage(input: CreditPageInput) {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Credit page limit must be an integer between 1 and 100')
  }
  if (
    input.cursor &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(input.cursor.createdAt) ||
      !Number.isFinite(Date.parse(input.cursor.createdAt)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.cursor.id))
  ) {
    throw new RangeError('Invalid credit page cursor')
  }
  return limit
}

/** A single statement gives available/held/debt a consistent read snapshot. */
export async function getCreditBalance(
  db: CreditsExecutor,
  workspaceId: string,
  tx?: CreditsTransaction,
) {
  const [balance] = await (tx ?? db)
    .select({
      available: sql<number>`(select coalesce(sum(${creditGrant.remaining}), 0)::float8 from ${creditGrant}
      where ${creditGrant.workspaceId} = ${workspaceId} and ${creditGrant.status} = 'active'
      and (${creditGrant.expiresAt} is null or ${creditGrant.expiresAt} > now()))`,
      held: sql<number>`(select coalesce(sum(${creditHold.amount}), 0)::float8 from ${creditHold}
      where ${creditHold.workspaceId} = ${workspaceId} and ${creditHold.status} = 'held')`,
      debt: sql<number>`(select coalesce(sum(${creditDebt.amount}), 0)::float8 from ${creditDebt}
      where ${creditDebt.workspaceId} = ${workspaceId})`,
    })
    .from(sql`(select 1) as credit_snapshot`)
  if (!balance) throw new Error('Credit balance query returned no row')
  return balance
}

/** All grant statuses are visible as batch history, newest first. */
export async function getCreditBatches(
  db: CreditsExecutor,
  workspaceId: string,
  input: CreditPageInput = {},
  tx?: CreditsTransaction,
) {
  const limit = validatePage(input)
  const cursor = input.cursor
  const rows = await (tx ?? db)
    .select({
      item: creditGrant,
      timestamp: sql<string>`to_char(${creditGrant.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(creditGrant)
    .where(
      and(
        eq(creditGrant.workspaceId, workspaceId),
        cursor
          ? or(
              lt(creditGrant.createdAt, sql`${cursor.createdAt}::timestamptz`),
              and(
                eq(creditGrant.createdAt, sql`${cursor.createdAt}::timestamptz`),
                lt(creditGrant.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(creditGrant.createdAt), desc(creditGrant.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => row.item),
    nextCursor:
      rows.length > limit && last ? { createdAt: last.timestamp, id: last.item.id } : null,
  }
}

/** Member callers must supply their authenticated userId; never accept another user's ID. */
export async function getCreditLedger(
  db: CreditsExecutor,
  workspaceId: string,
  input: CreditPageInput & { userId?: string } = {},
  tx?: CreditsTransaction,
) {
  const limit = validatePage(input)
  const cursor = input.cursor
  const rows = await (tx ?? db)
    .select({
      item: creditLedger,
      timestamp: sql<string>`to_char(${creditLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, workspaceId),
        input.userId === undefined ? undefined : eq(creditLedger.userId, input.userId),
        cursor
          ? or(
              lt(creditLedger.createdAt, sql`${cursor.createdAt}::timestamptz`),
              and(
                eq(creditLedger.createdAt, sql`${cursor.createdAt}::timestamptz`),
                lt(creditLedger.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map((row) => row.item),
    nextCursor:
      rows.length > limit && last ? { createdAt: last.timestamp, id: last.item.id } : null,
  }
}

/**
 * Accounting includes ALL active remaining, even elapsed grants awaiting expiry.
 * Spendable getCreditBalance excludes those rows. Reading must not manufacture a
 * mismatch before the expiry mutation has appended its matching ledger entry.
 */
export async function reconcileWorkspaceCredits(
  db: CreditsExecutor,
  workspaceId: string,
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId)
    const [snapshot] = await tx
      .select({
        ledgerTotal: sql<number>`(select coalesce(sum(${creditLedger.delta}), 0)::float8 from ${creditLedger}
        where ${creditLedger.workspaceId} = ${workspaceId})`,
        activeRemaining: sql<number>`(select coalesce(sum(${creditGrant.remaining}), 0)::float8 from ${creditGrant}
        where ${creditGrant.workspaceId} = ${workspaceId} and ${creditGrant.status} = 'active')`,
        held: sql<number>`(select coalesce(sum(${creditHold.amount}), 0)::float8 from ${creditHold}
        where ${creditHold.workspaceId} = ${workspaceId} and ${creditHold.status} = 'held')`,
        debt: sql<number>`(select coalesce(sum(${creditDebt.amount}), 0)::float8 from ${creditDebt}
        where ${creditDebt.workspaceId} = ${workspaceId})`,
      })
      .from(sql`(select 1) as credit_snapshot`)
    if (!snapshot) throw new Error('Credit reconciliation query returned no row')
    const expectedTotal = snapshot.activeRemaining + snapshot.held - snapshot.debt
    const difference = snapshot.ledgerTotal - expectedTotal
    return { ...snapshot, expectedTotal, difference, consistent: difference === 0 }
  })
}
