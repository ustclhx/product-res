import {
  createDb,
  creditDailyClaim,
  creditGrant,
  creditLedger,
  member,
  organization,
  setting,
  user,
} from '@product-res/db'
import { newId, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { grantDailyCredits, revokeGrant } from '../src/index.ts'

const url = process.env.CREDITS_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated test database')
const db = createDb({ connectionString: url })
const ids: string[] = []
const keys = [
  'credits.dailyAmount',
  'credits.dailyMaxDaysPerMonth',
  'credits.dailyExpiryDays',
  'credits.dailyRequireVerifiedEmail',
  SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY,
]
const claim = (userId: string, day = '2026-11-01') =>
  grantDailyCredits({ db, userId, enabled: true, now: new Date(`${day}T12:34:56Z`) })

async function account(email?: string, verified = true) {
  const id = newId()
  ids.push(id)
  await db
    .insert(user)
    .values({ id, name: 'Daily', email: email ?? `${id}@example.test`, emailVerified: verified })
  await db.insert(organization).values({ id, name: 'Personal', slug: id, isPersonal: true })
  await db.insert(member).values({ id: newId(), organizationId: id, userId: id, role: 'owner' })
  return id
}
async function configure(key: string, value: unknown) {
  await db.$client`insert into setting(id,key,value) values (${newId()},${key},${JSON.stringify(value)}::jsonb)
    on conflict(key) do update set value=excluded.value`
}

afterEach(async () => {
  await db.delete(setting).where(inArray(setting.key, keys))
  if (!ids.length) return
  await db.delete(creditDailyClaim).where(inArray(creditDailyClaim.userId, ids))
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, ids))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, ids))
  await db.delete(member).where(inArray(member.organizationId, ids))
  await db.delete(organization).where(inArray(organization.id, ids))
  await db.delete(user).where(inArray(user.id, ids))
  ids.length = 0
})
afterAll(() => db.$client.end())

describe('daily credits on PostgreSQL', () => {
  it('returns disabled before any database access', async () => {
    const transaction = vi.spyOn(db, 'transaction')
    try {
      expect(await grantDailyCredits({ db, userId: newId(), enabled: false })).toEqual({
        status: 'disabled',
      })
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      transaction.mockRestore()
    }
  })

  it('commits one claim, grant and ledger under same-day retries; email changes cannot reclaim', async () => {
    const id = await account()
    const results = await Promise.all([claim(id), claim(id), claim(id)])
    expect(results.map((r) => r.status).sort()).toEqual([
      'already_claimed',
      'already_claimed',
      'granted',
    ])
    const result = results.find((r) => r.status === 'granted')
    expect(result).toMatchObject({
      credits: 10,
      day: '2026-11-01',
      daysThisMonth: 1,
      maxDaysPerMonth: 10,
      expiresAt: '2026-11-08T12:34:56.000Z',
    })
    const [batch] = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))
    expect(batch).toMatchObject({
      id: result?.grantId,
      amount: 10,
      paymentId: null,
      source: 'daily',
      sourceRef: `${id}:2026-11-01`,
    })
    expect(
      await db.select().from(creditDailyClaim).where(eq(creditDailyClaim.userId, id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, id)),
    ).toHaveLength(1)
    await db
      .update(user)
      .set({ email: `${newId()}@example.test` })
      .where(eq(user.id, id))
    expect(await claim(id)).toEqual({ status: 'already_claimed' })
  })

  it('preserves the monthly limit after changing email', async () => {
    await configure('credits.dailyMaxDaysPerMonth', 2)
    const id = await account()
    expect((await claim(id)).status).toBe('granted')
    expect((await claim(id, '2026-11-02')).status).toBe('granted')
    await db
      .update(user)
      .set({ email: `${newId()}@example.test` })
      .where(eq(user.id, id))
    expect(await claim(id, '2026-11-03')).toEqual({ status: 'monthly_limit' })
  })

  it('shares normalized email days across accounts and retains claims after deletion', async () => {
    const local = newId().replaceAll('-', '')
    const first = await account(`${local}@gmail.com`)
    const second = await account(`${local.slice(0, 4)}.${local.slice(4)}+alias@googlemail.com`)
    const results = await Promise.all([claim(first), claim(second)])
    expect(results.map((r) => r.status).sort()).toEqual(['already_claimed', 'granted'])
    const winner = results[0]?.status === 'granted' ? first : second
    await db.delete(member).where(eq(member.userId, winner))
    await db.delete(user).where(eq(user.id, winner))
    const third = await account(`${local}+new@gmail.com`)
    expect(await claim(third)).toEqual({ status: 'already_claimed' })
    const [record] = await db
      .select()
      .from(creditDailyClaim)
      .where(eq(creditDailyClaim.userId, winner))
    expect(record?.emailHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('enforces D+1, next-day progress and next-month reset independently of revoked batches', async () => {
    await configure('credits.dailyMaxDaysPerMonth', 2)
    const id = await account()
    const first = await claim(id)
    if (first.status !== 'granted') throw new Error('Missing grant')
    await revokeGrant(db, { workspaceId: id, grantId: first.grantId })
    expect(await claim(id, '2026-11-02')).toMatchObject({ status: 'granted', daysThisMonth: 2 })
    expect(await claim(id, '2026-11-03')).toEqual({ status: 'monthly_limit' })
    expect(await claim(id, '2026-12-01')).toMatchObject({ status: 'granted', daysThisMonth: 1 })
  })

  it('counts overlapping user and email history as distinct monthly days', async () => {
    await configure('credits.dailyMaxDaysPerMonth', 2)
    const id = await account()
    const local = newId()
    const other = await account(`${local}@gmail.com`)
    expect((await claim(id)).status).toBe('granted')
    expect((await claim(other)).status).toBe('granted')
    await db
      .update(user)
      .set({ email: `${local}+changed@gmail.com` })
      .where(eq(user.id, id))
    expect(await claim(id, '2026-11-02')).toMatchObject({ status: 'granted', daysThisMonth: 2 })
    expect(await claim(id, '2026-11-03')).toEqual({ status: 'monthly_limit' })
  })

  it('cleans only the claiming email history before the previous UTC month on success', async () => {
    const id = await account()
    const other = await account()
    for (const day of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']) {
      expect((await claim(id, day)).status).toBe('granted')
    }
    expect((await claim(other, '2026-09-30')).status).toBe('granted')
    expect(await claim(id, '2026-11-02')).toMatchObject({ status: 'granted', daysThisMonth: 2 })
    const retained = await db
      .select({ day: creditDailyClaim.day })
      .from(creditDailyClaim)
      .where(eq(creditDailyClaim.userId, id))
      .orderBy(creditDailyClaim.day)
    expect(retained.map((row) => row.day)).toEqual([
      '2026-10-01',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
    expect(
      await db.select().from(creditDailyClaim).where(eq(creditDailyClaim.userId, other)),
    ).toHaveLength(1)
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))).toHaveLength(
      5,
    )
  })

  it('grants separately on either side of UTC midnight', async () => {
    const id = await account()
    for (const [now, day, daysThisMonth] of [
      ['2026-11-01T23:59:59Z', '2026-11-01', 1],
      ['2026-11-02T00:00:00Z', '2026-11-02', 2],
    ] as const) {
      expect(
        await grantDailyCredits({ db, userId: id, enabled: true, now: new Date(now) }),
      ).toMatchObject({
        status: 'granted',
        day,
        daysThisMonth,
      })
    }
    expect(await claim(id, '2026-11-02')).toEqual({ status: 'already_claimed' })
  })

  it('serializes the final monthly day across different users and dates', async () => {
    await configure('credits.dailyMaxDaysPerMonth', 2)
    const local = newId()
    const first = await account(`${local}@gmail.com`)
    const second = await account(`${local}+two@gmail.com`)
    expect((await claim(first)).status).toBe('granted')
    const results = await Promise.all([claim(first, '2026-11-29'), claim(second, '2026-11-30')])
    expect(results.map((r) => r.status).sort()).toEqual(['granted', 'monthly_limit'])
    expect(
      await db.select().from(creditDailyClaim).where(inArray(creditDailyClaim.userId, ids)),
    ).toHaveLength(2)
  })

  it('uses the verified database identity and permits explicit verification policy override', async () => {
    const id = await account(undefined, false)
    expect(await claim(id)).toEqual({ status: 'unverified' })
    await configure('credits.dailyRequireVerifiedEmail', false)
    await configure('credits.dailyAmount', 25)
    await configure('credits.dailyExpiryDays', 1)
    expect(await claim(id)).toMatchObject({
      status: 'granted',
      credits: 25,
      expiresAt: '2026-11-02T12:34:56.000Z',
    })
  })

  it('shares signup blacklist rules without consuming the claim', async () => {
    await configure(SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY, [' DISPOSABLE.TEST. ', 'googlemail.com'])
    const id = await account(`${newId()}@mail.disposable.test`)
    const alias = await account(`${newId()}@googlemail.com`)
    expect(await claim(id)).toEqual({ status: 'blacklisted' })
    expect(await claim(alias)).toEqual({ status: 'blacklisted' })
    await configure(SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY, [])
    expect((await claim(id)).status).toBe('granted')
  })

  it('rejects banned accounts and unavailable/non-owner personal workspaces', async () => {
    const id = await account()
    await db.update(user).set({ banned: true }).where(eq(user.id, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    await db.update(user).set({ banned: false }).where(eq(user.id, id))
    await db.update(member).set({ role: 'member' }).where(eq(member.userId, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'PERSONAL_WORKSPACE_REQUIRED' })
    await db.update(member).set({ role: 'owner' }).where(eq(member.userId, id))
    await db.update(organization).set({ isPersonal: false }).where(eq(organization.id, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'PERSONAL_WORKSPACE_REQUIRED' })
    await db
      .update(organization)
      .set({ isPersonal: true, deletedAt: new Date() })
      .where(eq(organization.id, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'PERSONAL_WORKSPACE_REQUIRED' })
  })

  it('rejects invalid persisted settings and blacklists before writing grants', async () => {
    const id = await account()
    for (const [key, value] of [
      ['credits.dailyAmount', 0],
      ['credits.dailyAmount', '10'],
      ['credits.dailyAmount', 2_147_483_648],
      ['credits.dailyMaxDaysPerMonth', 32],
      ['credits.dailyExpiryDays', 1.5],
      ['credits.dailyRequireVerifiedEmail', 'true'],
      [SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY, null],
    ] as const) {
      await configure(key, value)
      await expect(claim(id)).rejects.toThrow()
      await db.delete(setting).where(eq(setting.key, key))
    }
    expect(await db.select().from(creditDailyClaim).where(eq(creditDailyClaim.userId, id))).toEqual(
      [],
    )
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))).toEqual([])
  })
})
