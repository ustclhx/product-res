import {
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  member,
  organization,
  user,
} from '@product-res/db'
import * as schema from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CreditsTransaction, capture, grant, hold, release } from '../src/index.ts'
import { getCreditBalance } from '../src/queries.ts'

const url = process.env.CREDITS_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated test database')
const client = postgres(url, { max: 5 })
const db = drizzle(client, { schema })
let ws: string
let otherWs: string
let userId: string
const grantInput = (amount = 10, sourceRef = newId()) => ({
  workspaceId: ws,
  source: 'admin' as const,
  sourceRef,
  amount,
})

const holdInput = (amount = 8) => ({
  workspaceId: ws,
  userId,
  amount,
  refType: 'ai_message' as const,
  refId: newId(),
})

beforeEach(async () => {
  ws = newId()
  otherWs = newId()
  userId = newId()
  await db.insert(user).values({ id: userId, name: 'Credits', email: `${userId}@example.test` })
  await db.insert(organization).values([
    { id: ws, name: 'Credits', slug: ws },
    { id: otherWs, name: 'Other', slug: otherWs },
  ])
  await db.insert(member).values({ id: newId(), organizationId: ws, userId, role: 'owner' })
})

afterEach(async () => {
  const workspaces = [ws, otherWs]
  const holds = await db
    .select({ id: creditHold.id })
    .from(creditHold)
    .where(inArray(creditHold.workspaceId, workspaces))
  if (holds.length)
    await db.delete(creditHoldAllocation).where(
      inArray(
        creditHoldAllocation.holdId,
        holds.map((h) => h.id),
      ),
    )
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, workspaces))
  await db.delete(creditHold).where(inArray(creditHold.workspaceId, workspaces))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, workspaces))
  await db.delete(creditDebt).where(inArray(creditDebt.workspaceId, workspaces))
  await db.delete(member).where(inArray(member.organizationId, workspaces))
  await db.delete(organization).where(inArray(organization.id, workspaces))
  await db.delete(user).where(eq(user.id, userId))
})

afterAll(() => client.end())

async function debt(amount: number, workspaceId = ws) {
  await db.insert(creditDebt).values({ workspaceId, amount })
  await db.insert(creditLedger).values({ workspaceId, type: 'debt', delta: -amount })
}

async function assertInvariant() {
  const grants = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
  const holds = await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))
  const debts = await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws))
  const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
  expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(
    grants.filter((g) => g.status === 'active').reduce((sum, g) => sum + g.remaining, 0) +
      holds.filter((h) => h.status === 'held').reduce((sum, h) => sum + h.amount, 0) -
      debts.reduce((sum, d) => sum + d.amount, 0),
  )
}

describe('grant and hold on PostgreSQL', () => {
  it('repeated/concurrent grant repays debt once and emits one grant ledger', async () => {
    await debt(20)
    const input = grantInput(100)
    const [first, replay] = await Promise.all([grant(db, input), grant(db, input)])
    expect(first.id).toBe(replay.id)
    expect(first.remaining).toBe(80)
    expect(await grant(db, input)).toEqual(first)
    expect(
      (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws)))[0]?.amount,
    ).toBe(0)
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    expect(ledger.filter((l) => l.type === 'grant').map((l) => l.delta)).toEqual([100])
    expect(ledger.filter((l) => l.type === 'debt_repay')).toEqual([
      expect.objectContaining({ delta: 0, note: 'Repaid 20 credits of debt' }),
    ])
    await assertInvariant()
  })

  it('smaller grant entirely repays debt and debt still prevents hold', async () => {
    await debt(20)
    expect((await grant(db, grantInput(10))).remaining).toBe(0)
    expect(
      (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws)))[0]?.amount,
    ).toBe(10)
    await expect(hold(db, holdInput(1))).rejects.toMatchObject({ code: 'CREDIT_DEBT' })
    await assertInvariant()
  })

  it('global duplicate in another workspace reveals no grant and leaves its debt untouched', async () => {
    await debt(20, otherWs)
    const input = grantInput(10)
    await grant(db, input)
    await expect(grant(db, { ...input, workspaceId: otherWs })).rejects.toMatchObject({
      code: 'SOURCE_ALREADY_GRANTED',
      message: 'SOURCE_ALREADY_GRANTED',
    })
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, otherWs))).toEqual(
      [],
    )
    expect(
      (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, otherWs)))[0]?.amount,
    ).toBe(20)
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, otherWs))).map(
        (l) => l.type,
      ),
    ).toEqual(['debt'])
  })

  it('concurrent global source claim in different workspaces grants only once', async () => {
    await debt(20)
    await debt(20, otherWs)
    const input = grantInput(10)
    const results = await Promise.allSettled([
      grant(db, input),
      grant(db, { ...input, workspaceId: otherWs }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'SOURCE_ALREADY_GRANTED' }),
      }),
    ])
    const debts = await db
      .select()
      .from(creditDebt)
      .where(inArray(creditDebt.workspaceId, [ws, otherWs]))
    expect(debts.map((d) => d.amount).sort()).toEqual([10, 20])
  })

  it('balance 10 with two concurrent holds of 8 has exactly one success', async () => {
    const batch = await grant(db, grantInput(10))
    const results = await Promise.allSettled([hold(db, holdInput()), hold(db, holdInput())])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'INSUFFICIENT_CREDITS' }),
      }),
    ])
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
    ).toBe(2)
    expect(await db.select().from(creditHoldAllocation)).toContainEqual(
      expect.objectContaining({ grantId: batch.id, amount: 8 }),
    )
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    expect(ledger.map((l) => l.type)).toEqual(['grant'])
    await assertInvariant()
  })

  it('uses expiry, creation, id order, skips expired/revoked and uses never-expiring last', async () => {
    const expiry = new Date(Date.now() + 86_400_000)
    const permanent = await grant(db, grantInput(4))
    const later = await grant(db, {
      ...grantInput(4),
      expiresAt: new Date(expiry.getTime() + 86_400_000),
    })
    const early1 = await grant(db, { ...grantInput(3), expiresAt: expiry })
    const early2 = await grant(db, { ...grantInput(3), expiresAt: expiry })
    const expired = await grant(db, { ...grantInput(9), expiresAt: new Date(0) })
    const revoked = await grant(db, grantInput(9))
    await db.update(creditGrant).set({ status: 'revoked' }).where(eq(creditGrant.id, revoked.id))
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(0) })
      .where(inArray(creditGrant.id, [early1.id, early2.id]))
    const older = await grant(db, { ...grantInput(2), expiresAt: expiry })
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(-1000) })
      .where(eq(creditGrant.id, older.id))
    const oldest = await hold(db, holdInput(2))
    expect(
      await db
        .select()
        .from(creditHoldAllocation)
        .where(eq(creditHoldAllocation.holdId, oldest.id)),
    ).toEqual([expect.objectContaining({ grantId: older.id, amount: 2 })])
    const tied = await hold(db, holdInput(2))
    expect(
      await db.select().from(creditHoldAllocation).where(eq(creditHoldAllocation.holdId, tied.id)),
    ).toEqual([expect.objectContaining({ grantId: [early1.id, early2.id].sort()[0], amount: 2 })])
    const reservation = await hold(db, holdInput(6))
    const allocations = await db
      .select()
      .from(creditHoldAllocation)
      .where(eq(creditHoldAllocation.holdId, reservation.id))
    expect(allocations.map((a) => [a.grantId, a.amount]).sort()).toEqual(
      [
        [early1.id, early1.id < early2.id ? 1 : 3],
        [early2.id, early2.id < early1.id ? 1 : 3],
        [later.id, 2],
      ].sort(),
    )
    const rows = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    expect(rows.find((r) => r.id === permanent.id)?.remaining).toBe(4)
    expect(rows.find((r) => r.id === expired.id)?.remaining).toBe(9)
    expect(rows.find((r) => r.id === revoked.id)?.remaining).toBe(9)
  })

  it('insufficiency writes nothing even when caught in an external transaction', async () => {
    const batch = await grant(db, grantInput(10))
    await db.transaction(async (tx) => {
      await expect(hold(db, holdInput(11), tx)).rejects.toMatchObject({
        code: 'INSUFFICIENT_CREDITS',
      })
    })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
    ).toBe(10)
    expect(await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))).toEqual([])
    await assertInvariant()
  })

  it('external transaction rollback undoes grant, debt repayment, hold, allocation and ledger together', async () => {
    await debt(20)
    const input = grantInput(100)
    await expect(
      db.transaction(async (tx) => {
        await tx.update(organization).set({ name: 'Changed' }).where(eq(organization.id, ws))
        await grant(db, input, tx)
        await hold(db, holdInput(30), tx)
        throw new Error('rollback caller')
      }),
    ).rejects.toThrow('rollback caller')
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
    expect(await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))).toEqual([])
    expect(
      (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws)))[0]?.amount,
    ).toBe(20)
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).map(
        (l) => l.type,
      ),
    ).toEqual(['debt'])
    expect((await db.select().from(organization).where(eq(organization.id, ws)))[0]?.name).toBe(
      'Credits',
    )
    await assertInvariant()
  })

  it('raw postgres transaction adapter participates without beginning a nested transaction', async () => {
    await expect(
      client.begin(async (rawTx) => {
        // Installed Drizzle requires client.options; TransactionSql omits it at runtime.
        const adapter = drizzle(
          Object.assign(rawTx, { options: client.options }) as unknown as postgres.Sql,
          { schema },
        ) as unknown as CreditsTransaction
        await grant(db, grantInput(10), adapter)
        await hold(db, holdInput(8), adapter)
        await rawTx`update organization set name='Raw changed' where id=${ws}`
        throw new Error('rollback raw caller')
      }),
    ).rejects.toThrow('rollback raw caller')
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
    expect(await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))).toEqual([])
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).toEqual([])
    expect((await db.select().from(organization).where(eq(organization.id, ws)))[0]?.name).toBe(
      'Credits',
    )
  })

  it('a transaction passed as the executor is joined directly and rolled back by its caller', async () => {
    await expect(
      db.transaction(async (tx) => {
        const nested = vi.spyOn(tx, 'transaction')
        await tx.update(organization).set({ name: 'Changed' }).where(eq(organization.id, ws))
        await grant(tx, grantInput(10))
        const reservation = await hold(tx, holdInput(8))
        await capture(tx, { workspaceId: ws, holdId: reservation.id, actualAmount: 3 })
        await release(tx, { workspaceId: ws, holdId: (await hold(tx, holdInput(2))).id })
        expect(await getCreditBalance(tx, ws)).toEqual({ available: 7, held: 0, debt: 0 })
        // Uncommitted: other connections cannot see the caller's writes yet.
        expect(await getCreditBalance(db, ws)).toEqual({ available: 0, held: 0, debt: 0 })
        expect(nested).not.toHaveBeenCalled()
        throw new Error('rollback executor caller')
      }),
    ).rejects.toThrow('rollback executor caller')
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).toEqual([])
    expect(await db.select().from(creditHold).where(eq(creditHold.workspaceId, ws))).toEqual([])
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).toEqual([])
    expect((await db.select().from(organization).where(eq(organization.id, ws)))[0]?.name).toBe(
      'Credits',
    )
  })

  it('a transaction passed as the executor commits only when its caller commits', async () => {
    const reservation = await db.transaction(async (tx) => {
      const nested = vi.spyOn(tx, 'transaction')
      await grant(tx, grantInput(10))
      const created = await hold(tx, holdInput(8))
      expect(nested).not.toHaveBeenCalled()
      return created
    })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 2, held: 8, debt: 0 })
    await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 8 })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 2, held: 0, debt: 0 })
    await assertInvariant()
  })

  it('rejects unsafe amounts and workspace-mismatched users at exported boundaries', async () => {
    for (const amount of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(grant(db, grantInput(amount))).rejects.toMatchObject({
        code: 'INVALID_CREDIT_AMOUNT',
      })
      await expect(hold(db, holdInput(amount))).rejects.toMatchObject({
        code: 'INVALID_CREDIT_AMOUNT',
      })
    }
    await expect(hold(db, { ...holdInput(1), workspaceId: otherWs })).rejects.toMatchObject({
      code: 'WORKSPACE_RESOURCE_NOT_FOUND',
    })
  })
})

describe('capture and release on PostgreSQL', () => {
  it('concurrent capture/release has one winner and repeated settlement writes nothing', async () => {
    const batch = await grant(db, grantInput(10))
    const reservation = await hold(db, holdInput(8))
    const input = { workspaceId: ws, holdId: reservation.id }
    const results = await Promise.allSettled([
      capture(db, { ...input, actualAmount: 3 }),
      release(db, input),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'HOLD_NOT_ACTIVE' }) }),
    ])
    const [settled] = await db.select().from(creditHold).where(eq(creditHold.id, reservation.id))
    const remaining = settled?.status === 'captured' ? 7 : 10
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
    ).toBe(remaining)
    const before = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    await expect(capture(db, { ...input, actualAmount: 3 })).rejects.toMatchObject({
      code: 'HOLD_NOT_ACTIVE',
    })
    await expect(release(db, input)).rejects.toMatchObject({ code: 'HOLD_NOT_ACTIVE' })
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).toEqual(
      before,
    )
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
    ).toBe(remaining)
    expect(
      await db
        .select()
        .from(creditHoldAllocation)
        .where(eq(creditHoldAllocation.holdId, reservation.id)),
    ).toEqual([expect.objectContaining({ grantId: batch.id, amount: 8 })])
    await assertInvariant()
  })

  it('partial capture consumes expiry/creation/id order and returns the unused tail', async () => {
    const expiry = new Date(Date.now() + 86_400_000)
    const permanent = await grant(db, grantInput(4))
    const later = await grant(db, {
      ...grantInput(4),
      expiresAt: new Date(expiry.getTime() + 1000),
    })
    const tied1 = await grant(db, { ...grantInput(4), expiresAt: expiry })
    const tied2 = await grant(db, { ...grantInput(4), expiresAt: expiry })
    const older = await grant(db, { ...grantInput(4), expiresAt: expiry })
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(0) })
      .where(inArray(creditGrant.id, [tied1.id, tied2.id]))
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(-1000) })
      .where(eq(creditGrant.id, older.id))
    const reservation = await hold(db, holdInput(20))
    expect(await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 7 })).toEqual(
      { captured: 7, absorbed: 0, debited: 0, debt: 0 },
    )
    const rows = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    const firstTie = tied1.id < tied2.id ? tied1.id : tied2.id
    const secondTie = tied1.id < tied2.id ? tied2.id : tied1.id
    expect(Object.fromEntries(rows.map((r) => [r.id, r.remaining]))).toEqual({
      [older.id]: 0,
      [firstTie]: 1,
      [secondTie]: 4,
      [later.id]: 4,
      [permanent.id]: 4,
    })
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0],
    ).toMatchObject({
      status: 'captured',
      capturedAmount: 7,
      overageAbsorbed: 0,
      overageDebited: 0,
      overageDebt: 0,
    })
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).filter(
        (l) => l.type === 'consume',
      ),
    ).toEqual([expect.objectContaining({ delta: -7, userId })])
    await assertInvariant()
  })

  it.each([undefined, 0, 3, 8])(
    'settles expired reservations with actual %s before expiry cron without resurrection',
    async (actualAmount) => {
      const batch = await grant(db, grantInput(10))
      const reservation = await hold(db, holdInput(8))
      await db
        .update(creditGrant)
        .set({ expiresAt: new Date(0) })
        .where(eq(creditGrant.id, batch.id))
      const input = { workspaceId: ws, holdId: reservation.id }
      if (actualAmount === undefined) await release(db, input)
      else await capture(db, { ...input, actualAmount })
      expect(
        (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0],
      ).toMatchObject({ remaining: 0, status: 'expired' })
      const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
      expect(ledger.filter((l) => l.type === 'expire').reduce((sum, l) => sum + l.delta, 0)).toBe(
        -(10 - (actualAmount ?? 0)),
      )
      expect(ledger.filter((l) => l.type === 'consume').map((l) => l.delta)).toEqual(
        actualAmount === undefined ? [] : [actualAmount === 0 ? 0 : -actualAmount],
      )
      await expect(hold(db, holdInput(1))).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' })
      await assertInvariant()
    },
  )

  it('two holds touching an expired grant cancel its unreserved remainder exactly once', async () => {
    const batch = await grant(db, grantInput(10))
    const first = await hold(db, holdInput(3))
    const second = await hold(db, holdInput(3))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, batch.id))
    await release(db, { workspaceId: ws, holdId: first.id })
    await assertInvariant()
    await capture(db, { workspaceId: ws, holdId: second.id, actualAmount: 2 })
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    expect(
      ledger
        .filter((l) => l.type === 'expire')
        .map((l) => l.delta)
        .sort((a, b) => a - b),
    ).toEqual([-4, -3, -1])
    await assertInvariant()
  })

  it.each(['expired', 'revoked'] as const)(
    'returns to a previously %s grant through cancellation ledger only',
    async (status) => {
      const batch = await grant(db, grantInput(10))
      const reservation = await hold(db, holdInput(8))
      await db.update(creditGrant).set({ status, remaining: 0 }).where(eq(creditGrant.id, batch.id))
      await db.insert(creditLedger).values({
        workspaceId: ws,
        grantId: batch.id,
        type: status === 'revoked' ? 'revoke' : 'expire',
        delta: -2,
      })
      await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 3 })
      const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
      expect(
        ledger
          .filter((l) => l.type === (status === 'revoked' ? 'revoke' : 'expire'))
          .map((l) => l.delta)
          .sort((a, b) => a - b),
      ).toEqual([-5, -2])
      expect(
        (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
      ).toBe(0)
      await assertInvariant()
    },
  )

  it.each(['capture', 'release'] as const)(
    'caller rollback undoes %s, returns and expiry/consume ledger together',
    async (operation) => {
      const batch = await grant(db, grantInput(10))
      const reservation = await hold(db, holdInput(8))
      await db
        .update(creditGrant)
        .set({ expiresAt: new Date(0) })
        .where(eq(creditGrant.id, batch.id))
      await expect(
        db.transaction(async (tx) => {
          const input = { workspaceId: ws, holdId: reservation.id }
          if (operation === 'capture') await capture(db, { ...input, actualAmount: 3 }, tx)
          else await release(db, input, tx)
          await tx.update(organization).set({ name: 'Changed' }).where(eq(organization.id, ws))
          throw new Error('rollback settlement caller')
        }),
      ).rejects.toThrow('rollback settlement caller')
      expect(
        (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0]?.status,
      ).toBe('held')
      expect(
        (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0],
      ).toMatchObject({ remaining: 2, status: 'active' })
      expect(
        (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).map(
          (l) => l.type,
        ),
      ).toEqual(['grant'])
      expect((await db.select().from(organization).where(eq(organization.id, ws)))[0]?.name).toBe(
        'Credits',
      )
    },
  )

  it('workspace mismatch reveals no hold and leaves balances and ledger untouched', async () => {
    await grant(db, grantInput(10))
    const reservation = await hold(db, holdInput(8))
    const input = { workspaceId: otherWs, holdId: reservation.id }
    await expect(capture(db, { ...input, actualAmount: 3 })).rejects.toMatchObject({
      code: 'WORKSPACE_RESOURCE_NOT_FOUND',
    })
    await expect(release(db, input)).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_NOT_FOUND' })
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0]?.status,
    ).toBe('held')
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, otherWs)),
    ).toEqual([])
    await assertInvariant()
  })

  it('invalid actual amounts and overage policy rejection do not settle a hold in a caller transaction', async () => {
    await grant(db, grantInput(10))
    const reservation = await hold(db, holdInput(8))
    const input = { workspaceId: ws, holdId: reservation.id }
    await db.transaction(async (tx) => {
      for (const actualAmount of [-1, 1.5, Number.NaN, 2_147_483_648]) {
        await expect(capture(db, { ...input, actualAmount }, tx)).rejects.toMatchObject({
          code: 'INVALID_CREDIT_AMOUNT',
        })
      }
      await expect(
        capture(db, { ...input, actualAmount: 9, overage: { maxRatio: -1 } }, tx),
      ).rejects.toMatchObject({
        code: 'INVALID_OVERAGE_POLICY',
      })
    })
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0]?.status,
    ).toBe('held')
    await release(db, input)
    await assertInvariant()
  })
})

describe('overage capture on PostgreSQL', () => {
  it.each([
    { balance: 100, actual: 110, absorbed: 10, debited: 0, debt: 0 },
    { balance: 150, actual: 150, absorbed: 20, debited: 30, debt: 0 },
    { balance: 110, actual: 150, absorbed: 20, debited: 10, debt: 20 },
  ])('settles the specified scenario $balance -> $actual', async (scenario) => {
    await grant(db, grantInput(scenario.balance))
    const reservation = await hold(db, holdInput(100))
    const result = await capture(db, {
      workspaceId: ws,
      holdId: reservation.id,
      actualAmount: scenario.actual,
    })
    expect(result).toEqual({
      captured: 100,
      absorbed: scenario.absorbed,
      debited: scenario.debited,
      debt: scenario.debt,
    })
    expect(Object.values(result).reduce((sum, value) => sum + value, 0)).toBe(scenario.actual)
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0],
    ).toMatchObject({
      capturedAmount: 100,
      overageAbsorbed: scenario.absorbed,
      overageDebited: scenario.debited,
      overageDebt: scenario.debt,
    })
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))
    expect(ledger.filter((l) => l.type === 'consume').map((l) => l.delta)).toEqual([
      -(100 + scenario.debited),
    ])
    expect(ledger.filter((l) => l.type === 'debt').map((l) => l.delta)).toEqual(
      scenario.debt ? [-scenario.debt] : [],
    )
    await assertInvariant()
    if (scenario.debt) {
      await expect(hold(db, holdInput(1))).rejects.toMatchObject({ code: 'CREDIT_DEBT' })
      const input = grantInput(30)
      const results = await Promise.all([grant(db, input), grant(db, input)])
      expect(results.map((r) => r.remaining)).toEqual([10, 10])
      expect(results[0]?.id).toBe(results[1]?.id)
      expect(
        (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws)))[0]?.amount,
      ).toBe(0)
      await assertInvariant()
    }
  })

  it('serializes daily absorption at exactly 200, including prior-day holds settling today', async () => {
    await grant(db, grantInput(1600))
    const reservations = []
    for (let i = 0; i < 6; i++) reservations.push(await hold(db, holdInput(250)))
    await db
      .update(creditHold)
      .set({ createdAt: new Date(0), updatedAt: new Date(0) })
      .where(
        inArray(
          creditHold.id,
          reservations.map((r) => r.id),
        ),
      )
    const first = await capture(db, {
      workspaceId: ws,
      holdId: reservations[0]?.id ?? '',
      actualAmount: 300,
    })
    expect(first.absorbed).toBe(50)
    const results = await Promise.all(
      reservations.slice(1).map((r) =>
        capture(db, {
          workspaceId: ws,
          holdId: r.id,
          actualAmount: 300,
        }),
      ),
    )
    expect(first.absorbed + results.reduce((sum, r) => sum + r.absorbed, 0)).toBe(200)
    expect(results.reduce((sum, r) => sum + r.debited, 0)).toBe(100)
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(creditHold)
      .where(sql`${creditHold.workspaceId} = ${ws} and
        ${creditHold.updatedAt} >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`)
    expect(count).toBe(6)
    await assertInvariant()
  })

  it.each([
    { held: 1000, actual: 1200, absorbed: 50, debt: 150 },
    { held: 8, actual: 10, absorbed: 1, debt: 1 },
  ])('caps and floors single-capture absorption for held $held', async (scenario) => {
    await grant(db, grantInput(scenario.held))
    const reservation = await hold(db, holdInput(scenario.held))
    expect(
      await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: scenario.actual }),
    ).toEqual({
      captured: scenario.held,
      absorbed: scenario.absorbed,
      debited: 0,
      debt: scenario.debt,
    })
    await assertInvariant()
  })

  it('yesterday settlement does not consume today budget and pre-existing holds accumulate debt', async () => {
    await grant(db, grantInput(300))
    const first = await hold(db, holdInput(100))
    const second = await hold(db, holdInput(100))
    const third = await hold(db, holdInput(100))
    await capture(db, { workspaceId: ws, holdId: first.id, actualAmount: 120 })
    await db
      .update(creditHold)
      .set({ updatedAt: new Date(0) })
      .where(eq(creditHold.id, first.id))
    const overage = { dailyBudgetPerWorkspace: 20 }
    expect(
      await capture(db, { workspaceId: ws, holdId: second.id, actualAmount: 150, overage }),
    ).toEqual({ captured: 100, absorbed: 20, debited: 0, debt: 30 })
    expect(
      await capture(db, { workspaceId: ws, holdId: third.id, actualAmount: 150, overage }),
    ).toEqual({ captured: 100, absorbed: 0, debited: 0, debt: 50 })
    expect(
      (await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws)))[0]?.amount,
    ).toBe(80)
    await assertInvariant()
  })

  it('supplementary debit uses expiry/creation/id order and lazily cancels expired remaining', async () => {
    const initial = await grant(db, grantInput(100))
    const reservation = await hold(db, holdInput(100))
    const stale = await grant(db, grantInput(9))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, stale.id))
    const permanent = await grant(db, grantInput(20))
    const expiry = new Date(Date.now() + 86_400_000)
    const older = await grant(db, { ...grantInput(5), expiresAt: expiry })
    const tied1 = await grant(db, { ...grantInput(5), expiresAt: expiry })
    const tied2 = await grant(db, { ...grantInput(5), expiresAt: expiry })
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(0) })
      .where(inArray(creditGrant.id, [tied1.id, tied2.id]))
    await db
      .update(creditGrant)
      .set({ createdAt: new Date(-1000) })
      .where(eq(creditGrant.id, older.id))
    expect(
      await capture(db, {
        workspaceId: ws,
        holdId: reservation.id,
        actualAmount: 108,
        overage: { maxCredits: 0 },
      }),
    ).toEqual({ captured: 100, absorbed: 0, debited: 8, debt: 0 })
    const rows = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    expect(Object.fromEntries(rows.map((r) => [r.id, r.remaining]))).toEqual({
      [initial.id]: 0,
      [stale.id]: 0,
      [permanent.id]: 20,
      [older.id]: 0,
      [tied1.id < tied2.id ? tied1.id : tied2.id]: 2,
      [tied1.id < tied2.id ? tied2.id : tied1.id]: 5,
    })
    expect(rows.find((r) => r.id === stale.id)?.status).toBe('expired')
    await assertInvariant()
  })

  it('overage capture/release race applies only one settlement', async () => {
    await grant(db, grantInput(110))
    const reservation = await hold(db, holdInput(100))
    const input = { workspaceId: ws, holdId: reservation.id }
    const results = await Promise.allSettled([
      capture(db, { ...input, actualAmount: 150 }),
      release(db, input),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'HOLD_NOT_ACTIVE' }) }),
    ])
    await assertInvariant()
  })

  it('caller rollback restores overage, supplementary debit, debt, and ledger together', async () => {
    const batch = await grant(db, grantInput(110))
    const reservation = await hold(db, holdInput(100))
    await expect(
      db.transaction(async (tx) => {
        expect(
          await capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 150 }, tx),
        ).toEqual({ captured: 100, absorbed: 20, debited: 10, debt: 20 })
        throw new Error('rollback overage')
      }),
    ).rejects.toThrow('rollback overage')
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0],
    ).toMatchObject({
      status: 'held',
      capturedAmount: 0,
      overageAbsorbed: 0,
      overageDebited: 0,
      overageDebt: 0,
    })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, batch.id)))[0]?.remaining,
    ).toBe(10)
    expect(await db.select().from(creditDebt).where(eq(creditDebt.workspaceId, ws))).toEqual([])
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws))).map(
        (l) => l.type,
      ),
    ).toEqual(['grant'])
    await assertInvariant()
  })

  it('debt overflow caught by a caller leaves the state gate and all balances untouched', async () => {
    await grant(db, grantInput(100))
    const reservation = await hold(db, holdInput(100))
    await debt(2_147_483_647)
    await db.transaction(async (tx) => {
      await expect(
        capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 150 }, tx),
      ).rejects.toMatchObject({ code: 'INVALID_CREDIT_AMOUNT' })
    })
    expect(
      (await db.select().from(creditHold).where(eq(creditHold.id, reservation.id)))[0]?.status,
    ).toBe('held')
    await assertInvariant()
  })
})
