import {
  createDb,
  creditGrant,
  creditLedger,
  member,
  organization,
  setting,
  user,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { grantSignupBonus, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY } from './signup.ts'

const url = process.env.BILLING_TEST_DATABASE_URL
if (!url) throw new Error('Missing isolated billing test database')
const db = createDb({ connectionString: url })
const ids: string[] = []
const config = { signupBonusCredits: 100 }
const claim = (userId: string) => grantSignupBonus({ db, userId, config })
async function account(email?: string, verified = true) {
  const id = newId()
  ids.push(id)
  await db
    .insert(user)
    .values({ id, name: 'Signup', email: email ?? `${id}@example.test`, emailVerified: verified })
  await db.insert(organization).values({ id, name: 'Personal', slug: id, isPersonal: true })
  await db.insert(member).values({ id: newId(), organizationId: id, userId: id, role: 'owner' })
  return id
}
async function blacklist(value: unknown) {
  // JSON null is a valid persisted JSON shape; SQL NULL is forbidden by schema.
  await db.$client`insert into setting (id,key,value)
    values (${newId()},${SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY},${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value=excluded.value`
}
afterEach(async () => {
  await db.delete(setting).where(eq(setting.key, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY))
  if (!ids.length) return
  await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, ids))
  await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, ids))
  await db.delete(member).where(inArray(member.organizationId, ids))
  await db.delete(organization).where(inArray(organization.id, ids))
  await db.delete(user).where(inArray(user.id, ids))
  ids.length = 0
})
afterAll(() => db.$client.end())

describe('signup bonus on PostgreSQL', () => {
  it('uses the actual verified DB flag and grants/ledgers once under repeated concurrent claims', async () => {
    const id = await account(undefined, false)
    expect(await claim(id)).toEqual({ status: 'unverified' })
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))).toEqual([])
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, id))
    const results = await Promise.all([claim(id), claim(id), claim(id)])
    expect(results.map((r) => r.status).sort()).toEqual([
      'already_claimed',
      'already_claimed',
      'granted',
    ])
    expect(await claim(id)).toEqual({ status: 'already_claimed' })
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, id)),
    ).toHaveLength(1)
    const [batch] = await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))
    expect(batch).toMatchObject({ amount: 100, remaining: 100, source: 'signup', paymentId: null })
    expect(batch?.sourceRef).toMatch(/^[a-f0-9]{64}$/)
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, id))
    expect(await claim(id)).toEqual({ status: 'unverified' })
  })
  it('retains global email identity after account deletion and Gmail alias re-registration', async () => {
    const local = newId().replaceAll('-', '')
    const first = await account(`${local}@gmail.com`)
    expect((await claim(first)).status).toBe('granted')
    await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, first))
    await db.delete(member).where(eq(member.userId, first))
    await db.delete(user).where(eq(user.id, first))
    const second = await account(`${local.slice(0, 5)}.${local.slice(5)}+new@googlemail.com`)
    expect(await claim(second)).toEqual({ status: 'already_claimed' })
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, second))).toEqual(
      [],
    )
  })
  it('serializes concurrent first claims in different personal workspaces', async () => {
    const local = newId()
    const first = await account(`${local}@gmail.com`)
    const second = await account(`${local}+other@gmail.com`)
    const results = await Promise.all([claim(first), claim(second)])
    expect(results.map((r) => r.status).sort()).toEqual(['already_claimed', 'granted'])
    expect(
      await db
        .select()
        .from(creditGrant)
        .where(inArray(creditGrant.workspaceId, [first, second])),
    ).toHaveLength(1)
  })
  it('denies normalized exact/subdomains, permits lookalike domains, and defers rather than consumes the claim', async () => {
    await blacklist([' DISPOSABLE.TEST. '])
    const exact = await account()
    const sub = await account()
    const safe = await account()
    await db
      .update(user)
      .set({ email: `${exact}@disposable.test` })
      .where(eq(user.id, exact))
    await db
      .update(user)
      .set({ email: `${sub}@mail.disposable.test` })
      .where(eq(user.id, sub))
    await db
      .update(user)
      .set({ email: `${safe}@notdisposable.test` })
      .where(eq(user.id, safe))
    expect(await claim(exact)).toEqual({ status: 'blacklisted' })
    expect(await claim(sub)).toEqual({ status: 'blacklisted' })
    expect((await claim(safe)).status).toBe('granted')
    await blacklist([])
    expect((await claim(exact)).status).toBe('granted')
  })
  it('rejects malformed persisted blacklist instead of granting with an empty fallback', async () => {
    const id = await account()
    for (const value of [null, {}, ['ok.test', 123], [''], ['@bad.test']]) {
      await blacklist(value)
      await expect(claim(id)).rejects.toThrow('Invalid signup bonus domain blacklist')
    }
    expect(await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, id))).toEqual([])
  })
  it('requires personal ownership and supports disabled bonuses', async () => {
    const id = await account()
    expect(await grantSignupBonus({ db, userId: id, config: { signupBonusCredits: 0 } })).toEqual({
      status: 'disabled',
    })
    await db.update(member).set({ role: 'member' }).where(eq(member.userId, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'PERSONAL_WORKSPACE_REQUIRED' })
    await db.update(member).set({ role: 'owner' }).where(eq(member.userId, id))
    await db.update(organization).set({ isPersonal: false }).where(eq(organization.id, id))
    await expect(claim(id)).rejects.toMatchObject({ code: 'PERSONAL_WORKSPACE_REQUIRED' })
  })
})
