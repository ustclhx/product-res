import {
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  member,
  organization,
  payment,
  plan,
  planPrice,
  subscription,
  user,
} from '@product-res/db'
import * as schema from '@product-res/db/schema'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capture, grant, hold, release } from '../src/index.ts'

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
  await db.delete(payment).where(inArray(payment.workspaceId, workspaces))
  await db.delete(subscription).where(inArray(subscription.workspaceId, workspaces))
  await db.delete(planPrice).where(eq(planPrice.planId, ws))
  await db.delete(plan).where(eq(plan.id, ws))
  await db.delete(member).where(inArray(member.organizationId, workspaces))
  await db.delete(organization).where(inArray(organization.id, workspaces))
  await db.delete(user).where(eq(user.id, userId))
})

afterAll(() => client.end())

import {
  expireWorkspaceCredits,
  keptCredits,
  reducePaymentCredits,
  revokeGrant,
  revokePaymentCredits,
  revokeWorkspaceCredits,
} from '../src/lifecycle.ts'
import { getCreditBalance, reconcileWorkspaceCredits } from '../src/queries.ts'

async function invariant() {
  expect(await reconcileWorkspaceCredits(db, ws)).toMatchObject({ consistent: true, difference: 0 })
}

async function annualPayment() {
  await db.insert(plan).values({
    id: ws,
    key: ws,
    name: 'Annual',
    type: 'subscription',
    credits: 10,
    features: {
      models: [],
      maxConcurrentTasks: 1,
      maxSeats: 1,
      storageGb: 1,
      publicApi: false,
      priorityQueue: false,
      watermark: false,
    },
  })
  const [price] = await db
    .insert(planPrice)
    .values({
      planId: ws,
      provider: 'stripe',
      providerPriceId: newId(),
      interval: 'year',
      amount: 100,
      currency: 'USD',
    })
    .returning()
  if (!price) throw new Error('Missing price')
  const [sub] = await db
    .insert(subscription)
    .values({
      workspaceId: ws,
      planId: ws,
      planPriceId: price.id,
      provider: 'stripe',
      providerSubscriptionId: newId(),
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 86400000),
      lastEventAt: new Date(),
    })
    .returning()
  if (!sub) throw new Error('Missing subscription')
  const [paid] = await db
    .insert(payment)
    .values({
      workspaceId: ws,
      provider: 'stripe',
      providerPaymentId: newId(),
      subscriptionId: sub.id,
      kind: 'initial',
      amount: 100,
      currency: 'USD',
      paidAt: new Date(),
    })
    .returning()
  if (!paid) throw new Error('Missing payment')
  return paid
}

describe('credits lifecycle on PostgreSQL', () => {
  it('revokes only the selected batch once and never restores held credits', async () => {
    const batch = await grant(db, grantInput(10))
    const reservation = await hold(db, holdInput(8))
    const other = await grant(db, grantInput(7))
    await expect(
      revokeGrant(db, { workspaceId: otherWs, grantId: batch.id }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_NOT_FOUND' })
    const results = await Promise.all([
      revokeGrant(db, { workspaceId: ws, grantId: batch.id }),
      revokeGrant(db, { workspaceId: ws, grantId: batch.id }),
    ])
    expect(results.reduce((sum, r) => sum + r.canceled, 0)).toBe(2)
    expect(await getCreditBalance(db, ws)).toEqual({ available: 7, held: 8, debt: 0 })
    await invariant()
    await release(db, { workspaceId: ws, holdId: reservation.id })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 7, held: 0, debt: 0 })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.id, other.id)))[0]?.remaining,
    ).toBe(7)
    await invariant()
  })

  it('expires zero-remaining grants and appends only unreserved loss once', async () => {
    const full = await grant(db, grantInput(8))
    const reserved = await hold(db, holdInput(8))
    const spare = await grant(db, grantInput(5))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(inArray(creditGrant.id, [full.id, spare.id]))
    expect(await expireWorkspaceCredits(db, ws)).toEqual({ grants: 2, canceled: 5 })
    expect(await expireWorkspaceCredits(db, ws)).toEqual({ grants: 0, canceled: 0 })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).every(
        (g) => g.status === 'expired' && g.remaining === 0,
      ),
    ).toBe(true)
    await invariant()
    await release(db, { workspaceId: ws, holdId: reserved.id })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 0, held: 0, debt: 0 })
    expect(
      (await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)))
        .filter((l) => l.type === 'expire')
        .map((l) => l.delta)
        .sort(),
    ).toEqual([-5, -8])
    await invariant()
  })

  it('revokes all twelve linked annual grants once, preserving outstanding holds and inactive states', async () => {
    const paid = await annualPayment()
    const batches = []
    for (let n = 0; n < 12; n++)
      batches.push(
        await grant(db, {
          ...grantInput(10, `${paid.id}:${n}`),
          source: 'subscription',
          paymentId: paid.id,
        }),
      )
    const spent = await hold(db, holdInput(3))
    await capture(db, { workspaceId: ws, holdId: spent.id, actualAmount: 2 })
    const reserved = await hold(db, holdInput(8))
    const inactive = batches[11]
    if (!inactive) throw new Error('Missing batch')
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, inactive.id))
    await expireWorkspaceCredits(db, ws)
    const untouched = await grant(db, grantInput(7))
    await grant(db, { ...grantInput(9), workspaceId: otherWs })
    await expect(
      revokePaymentCredits(db, { workspaceId: otherWs, paymentId: paid.id }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_NOT_FOUND' })
    const results = await Promise.all([
      revokePaymentCredits(db, { workspaceId: ws, paymentId: paid.id }),
      revokePaymentCredits(db, { workspaceId: ws, paymentId: paid.id }),
    ])
    expect(results.reduce((sum, r) => sum + r.grants, 0)).toBe(11)
    expect(results.reduce((sum, r) => sum + r.canceled, 0)).toBe(100)
    await invariant()
    await release(db, { workspaceId: ws, holdId: reserved.id })
    expect(await getCreditBalance(db, ws)).toEqual({ available: 7, held: 0, debt: 0 })
    const grants = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    expect(grants.find((g) => g.id === inactive.id)?.status).toBe('expired')
    expect(grants.find((g) => g.id === untouched.id)?.remaining).toBe(7)
    expect(await getCreditBalance(db, otherWs)).toEqual({ available: 9, held: 0, debt: 0 })
    await invariant()
  })

  it('reduces linked grants to the unrefunded share once, without chasing consumed or held credits', async () => {
    const paid = await annualPayment()
    const batches: Awaited<ReturnType<typeof grant>>[] = []
    for (let n = 0; n < 12; n++)
      batches.push(
        await grant(db, {
          ...grantInput(10, `${paid.id}:${n}`),
          source: 'subscription',
          paymentId: paid.id,
        }),
      )
    // 首批先被消费 3、预扣 4，只剩 3 可收回
    const spent = await hold(db, holdInput(3))
    await capture(db, { workspaceId: ws, holdId: spent.id, actualAmount: 3 })
    const reserved = await hold(db, holdInput(4))
    const untouched = await grant(db, grantInput(7))
    await expect(
      reducePaymentCredits(db, {
        workspaceId: otherWs,
        paymentId: paid.id,
        share: { kept: 50, total: 100 },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_NOT_FOUND' })

    const half = { workspaceId: ws, paymentId: paid.id, share: { kept: 50, total: 100 } }
    const [first, replay] = await Promise.all([
      reducePaymentCredits(db, half),
      reducePaymentCredits(db, half),
    ])
    expect(first.revoked + replay.revoked).toBe(3 + 11 * 5)
    await invariant()

    // 累计退款到 75%：每批目标收回 10 - floor(2.5) = 8，扣除已收回部分
    const quarter = await reducePaymentCredits(db, { ...half, share: { kept: 25, total: 100 } })
    expect(quarter.revoked).toBe(11 * 3)
    await release(db, { workspaceId: ws, holdId: reserved.id })
    const afterRelease = await reducePaymentCredits(db, {
      ...half,
      share: { kept: 25, total: 100 },
    })
    expect(afterRelease.revoked).toBe(4)
    const grants = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))
    expect(grants.find((g) => g.id === batches[0]?.id)).toMatchObject({
      remaining: 0,
      status: 'active',
    })
    expect(grants.find((g) => g.id === batches[1]?.id)).toMatchObject({
      remaining: 2,
      status: 'active',
    })
    expect(grants.find((g) => g.id === untouched.id)?.remaining).toBe(7)
    expect(keptCredits(10, { kept: 0, total: 100 })).toBe(0)
    expect(() => keptCredits(10, { kept: 101, total: 100 })).toThrow()
    await invariant()
  })

  it.each(['capture', 'release'] as const)(
    'serializes expiry against %s with no resurrection or duplicate loss',
    async (operation) => {
      const batch = await grant(db, grantInput(10))
      const reservation = await hold(db, holdInput(8))
      await db
        .update(creditGrant)
        .set({ expiresAt: new Date(0) })
        .where(eq(creditGrant.id, batch.id))
      await Promise.all([
        expireWorkspaceCredits(db, ws),
        operation === 'capture'
          ? capture(db, { workspaceId: ws, holdId: reservation.id, actualAmount: 3 })
          : release(db, { workspaceId: ws, holdId: reservation.id }),
      ])
      expect(await expireWorkspaceCredits(db, ws)).toEqual({ grants: 0, canceled: 0 })
      expect(await getCreditBalance(db, ws)).toEqual({ available: 0, held: 0, debt: 0 })
      await invariant()
    },
  )

  it('workspace revocation cancels only active unreserved credits and supports caller rollback', async () => {
    await grant(db, grantInput(10))
    await grant(db, { ...grantInput(9), workspaceId: otherWs })
    const reservation = await hold(db, holdInput(8))
    await expect(
      db.transaction(async (tx) => {
        await revokeWorkspaceCredits(db, ws, tx)
        throw new Error('rollback lifecycle')
      }),
    ).rejects.toThrow('rollback lifecycle')
    expect(await getCreditBalance(db, ws)).toEqual({ available: 2, held: 8, debt: 0 })
    expect(await revokeWorkspaceCredits(db, ws)).toEqual({ grants: 1, canceled: 2 })
    expect(await revokeWorkspaceCredits(db, ws)).toEqual({ grants: 0, canceled: 0 })
    await release(db, { workspaceId: ws, holdId: reservation.id })
    expect((await getCreditBalance(db, ws)).available).toBe(0)
    expect((await getCreditBalance(db, otherWs)).available).toBe(9)
    await invariant()
  })

  it('lifecycle operations join a transaction passed as the executor', async () => {
    const paid = await annualPayment()
    const expiring = await grant(db, grantInput(5))
    await grant(db, {
      ...grantInput(10, `${paid.id}:0`),
      source: 'subscription',
      paymentId: paid.id,
    })
    await grant(db, grantInput(3))
    await db
      .update(creditGrant)
      .set({ expiresAt: new Date(0) })
      .where(eq(creditGrant.id, expiring.id))
    await expect(
      db.transaction(async (tx) => {
        const nested = vi.spyOn(tx, 'transaction')
        expect(await expireWorkspaceCredits(tx, ws)).toEqual({ grants: 1, canceled: 5 })
        expect(await revokePaymentCredits(tx, { workspaceId: ws, paymentId: paid.id })).toEqual({
          grants: 1,
          canceled: 10,
        })
        expect(await revokeWorkspaceCredits(tx, ws)).toEqual({ grants: 1, canceled: 3 })
        expect(await getCreditBalance(tx, ws)).toEqual({ available: 0, held: 0, debt: 0 })
        expect(await reconcileWorkspaceCredits(tx, ws)).toMatchObject({ consistent: true })
        expect(nested).not.toHaveBeenCalled()
        throw new Error('rollback lifecycle executor')
      }),
    ).rejects.toThrow('rollback lifecycle executor')
    expect(await getCreditBalance(db, ws)).toEqual({ available: 13, held: 0, debt: 0 })
    expect(
      (await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, ws))).every(
        (g) => g.status === 'active',
      ),
    ).toBe(true)
    await invariant()
  })

  it.each([42, 12345, 987654321])(
    'maintains accounting after every operation in seeded sequence %s',
    async (seed) => {
      let state = seed
      const random = (bound: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state % bound
      }
      const reserved: string[] = []
      for (let step = 0; step < 70; step++) {
        const operation = step < 6 ? step : random(6)
        if (operation === 0) {
          await grant(db, grantInput(random(30) + 10))
        } else if (operation === 1) {
          const balance = await getCreditBalance(db, ws)
          if (balance.available && !balance.debt)
            reserved.push(
              (await hold(db, holdInput(Math.min(balance.available, random(8) + 1)))).id,
            )
        } else if (operation === 2 || operation === 3) {
          const id = reserved.pop()
          if (id) {
            if (operation === 2)
              await capture(db, {
                workspaceId: ws,
                holdId: id,
                actualAmount: random(20),
                overage: { maxCredits: 0 },
              })
            else await release(db, { workspaceId: ws, holdId: id })
          }
        } else if (operation === 4) {
          await db
            .update(creditGrant)
            .set({ expiresAt: new Date(0) })
            .where(eq(creditGrant.workspaceId, ws))
          await invariant()
          await expireWorkspaceCredits(db, ws)
        } else {
          await revokeWorkspaceCredits(db, ws)
        }
        await invariant()
      }
      for (const id of reserved) {
        await release(db, { workspaceId: ws, holdId: id })
        await invariant()
      }
    },
  )
})
