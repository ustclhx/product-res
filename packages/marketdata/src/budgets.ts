import {
  type BudgetSpec,
  decideReservation,
  nextReset,
  periodKey,
  type ReservationMode,
  zonedMidnight,
} from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { budgetLedger, dataSource, sourceBudget } from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { isPaused } from './sources.ts'

/**
 * 事务内预扣额度（specs/source-budgets「事务内预扣」）：先锁定该数据源本周期的额度行，再判断、记账。
 * 账本金额是“用量变化量”：reserve +估算，settle 实际 − 估算，release −估算，expire 0（预扣视为已花）。
 */

export type ReserveResult =
  | {
      readonly ok: true
      readonly reservationId: string
      readonly periodKey: string
      readonly amount: number
    }
  | {
      readonly ok: false
      readonly reason: 'safety-line' | 'hard-cap' | 'daily-allowance' | 'paused'
      readonly limit: number
      readonly resetsAt: Date
    }

export interface ReserveInput {
  readonly sourceId: string
  readonly spec: BudgetSpec
  readonly amount: number
  readonly mode: ReservationMode
  readonly now: Date
  readonly runId?: string
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

async function lockPeriod(tx: Tx, sourceId: string, spec: BudgetSpec, key: string) {
  await tx
    .insert(sourceBudget)
    .values({
      sourceId,
      periodKey: key,
      unit: spec.unit,
      hardCap: spec.hardCap,
      safetyLine: spec.safetyLine,
    })
    .onConflictDoNothing()
  const [row] = await tx
    .select()
    .from(sourceBudget)
    .where(and(eq(sourceBudget.sourceId, sourceId), eq(sourceBudget.periodKey, key)))
    .for('update')
  if (!row) throw new Error('budget row missing after upsert')
  return row
}

/** 今天（数据源时区）的用量，供月度日分配使用 */
async function usedToday(tx: Tx, sourceId: string, key: string, spec: BudgetSpec, now: Date) {
  const day = periodKey({ period: 'day', timeZone: spec.timeZone }, now)
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const start = zonedMidnight(y, m, d, spec.timeZone)
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${budgetLedger.amount}), 0)` })
    .from(budgetLedger)
    .where(
      and(
        eq(budgetLedger.sourceId, sourceId),
        eq(budgetLedger.periodKey, key),
        gte(budgetLedger.createdAt, start),
      ),
    )
  return Number(row?.total ?? 0)
}

export async function reserve(db: Database, input: ReserveInput): Promise<ReserveResult> {
  const { sourceId, spec, amount, mode, now } = input
  const key = periodKey(spec, now)
  return db.transaction(async (tx) => {
    if (mode === 'scheduled') {
      const [source] = await tx.select().from(dataSource).where(eq(dataSource.id, sourceId))
      if (source && isPaused(source, now))
        return {
          ok: false,
          reason: 'paused',
          limit: 0,
          resetsAt: source.pausedUntil ?? nextReset(spec, now),
        }
    }
    const row = await lockPeriod(tx, sourceId, spec, key)
    // 配置可能已调低：以当前生效的上限为准
    const usage = {
      usedInPeriod: row.reserved + row.settled,
      ...(spec.period === 'month'
        ? { usedToday: await usedToday(tx, sourceId, key, spec, now) }
        : {}),
    }
    const decision = decideReservation(spec, usage, amount, mode, now)
    if (!decision.ok)
      return {
        ok: false,
        reason: decision.reason,
        limit: decision.limit,
        resetsAt: nextReset(spec, now),
      }
    const reservationId = newId()
    await tx
      .update(sourceBudget)
      .set({
        reserved: sql`${sourceBudget.reserved} + ${amount}`,
        hardCap: spec.hardCap,
        safetyLine: spec.safetyLine,
      })
      .where(and(eq(sourceBudget.sourceId, sourceId), eq(sourceBudget.periodKey, key)))
    await tx.insert(budgetLedger).values({
      sourceId,
      periodKey: key,
      reservationId,
      kind: 'reserve',
      amount,
      mode,
      ...(input.runId ? { runId: input.runId } : {}),
    })
    return { ok: true, reservationId, periodKey: key, amount }
  })
}

async function closeReservation(
  db: Database,
  reservationId: string,
  kind: 'settle' | 'release' | 'expire',
  actual?: number,
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(budgetLedger)
      .where(eq(budgetLedger.reservationId, reservationId))
    const reserved = rows.find((r) => r.kind === 'reserve')
    if (!reserved) throw new Error('Unknown reservation')
    // 幂等：已结算 / 释放 / 过期的预扣不再处理
    if (rows.some((r) => r.kind !== 'reserve')) return false
    await lockPeriod(
      tx,
      reserved.sourceId,
      { unit: 'call', period: 'day', hardCap: 0, safetyLine: 0, timeZone: 'UTC' },
      reserved.periodKey,
    )
    const spent =
      kind === 'release' ? 0 : kind === 'expire' ? reserved.amount : (actual ?? reserved.amount)
    await tx
      .update(sourceBudget)
      .set({
        reserved: sql`${sourceBudget.reserved} - ${reserved.amount}`,
        settled: sql`${sourceBudget.settled} + ${spent}`,
      })
      .where(
        and(
          eq(sourceBudget.sourceId, reserved.sourceId),
          eq(sourceBudget.periodKey, reserved.periodKey),
        ),
      )
    await tx.insert(budgetLedger).values({
      sourceId: reserved.sourceId,
      periodKey: reserved.periodKey,
      reservationId,
      kind,
      amount: spent - reserved.amount,
      mode: reserved.mode,
      runId: reserved.runId,
    })
    return true
  })
}

/** 按实际花费结算；未提供实际值时按预扣额结算 */
export const settle = (db: Database, reservationId: string, actual?: number) =>
  closeReservation(db, reservationId, 'settle', actual)

/** 未产生花费（如调用前失败）时释放预扣 */
export const release = (db: Database, reservationId: string) =>
  closeReservation(db, reservationId, 'release')

/**
 * 对账：超过时限仍未结算的预扣视为已花费（进程在预扣后、结算前崩溃）。宁可少用，不可超额。
 */
export async function expireStaleReservations(db: Database, now: Date, olderThanMinutes = 30) {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000)
  const stale = await db
    .select({ reservationId: budgetLedger.reservationId })
    .from(budgetLedger)
    .where(and(eq(budgetLedger.kind, 'reserve'), lt(budgetLedger.createdAt, cutoff)))
  if (stale.length === 0) return 0
  const closed = await db
    .select({ reservationId: budgetLedger.reservationId })
    .from(budgetLedger)
    .where(
      and(
        inArray(
          budgetLedger.reservationId,
          stale.map((s) => s.reservationId),
        ),
        inArray(budgetLedger.kind, ['settle', 'release', 'expire']),
      ),
    )
  const done = new Set(closed.map((c) => c.reservationId))
  let expired = 0
  for (const { reservationId } of stale) {
    if (done.has(reservationId)) continue
    if (await closeReservation(db, reservationId, 'expire')) expired++
  }
  return expired
}

/**
 * 记录外部响应报告的剩余额度；与账本相差超过阈值（默认硬上限的 10%）时暂停该数据源的定时任务。
 * 返回是否出现差异。
 */
export async function reconcileExternalRemaining(
  db: Database,
  sourceId: string,
  spec: BudgetSpec,
  remaining: number,
  now: Date,
  tolerance = 0.1,
) {
  const key = periodKey(spec, now)
  return db.transaction(async (tx) => {
    const row = await lockPeriod(tx, sourceId, spec, key)
    await tx
      .update(sourceBudget)
      .set({ externalRemaining: remaining, externalCheckedAt: now })
      .where(and(eq(sourceBudget.sourceId, sourceId), eq(sourceBudget.periodKey, key)))
    const localRemaining = spec.hardCap - row.reserved - row.settled
    const mismatch = localRemaining - remaining > spec.hardCap * tolerance
    if (mismatch)
      await tx
        .update(dataSource)
        .set({ pausedReason: 'quota-mismatch', pausedUntil: nextReset(spec, now) })
        .where(eq(dataSource.id, sourceId))
    return mismatch
  })
}

/** 当前周期用量，供数据中心显示 */
export async function currentUsage(db: Database, sourceId: string, spec: BudgetSpec, now: Date) {
  const key = periodKey(spec, now)
  const [row] = await db
    .select()
    .from(sourceBudget)
    .where(and(eq(sourceBudget.sourceId, sourceId), eq(sourceBudget.periodKey, key)))
  return {
    periodKey: key,
    used: row ? row.reserved + row.settled : 0,
    safetyLine: spec.safetyLine,
    hardCap: spec.hardCap,
    unit: spec.unit,
    externalRemaining: row?.externalRemaining ?? null,
    resetsAt: nextReset(spec, now),
  }
}
