import { env } from 'cloudflare:workers'
import { AppError, newId, toErrorResponse } from '@product-res/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditLog,
  createDb,
  type Database,
  invitation,
  member,
  NOT_FOUND_CODE,
  notification,
  organization,
  scoped,
  setting,
  user,
} from '../src/index.ts'

// tasks.md 4.3：scoped(db, ws) 的租户隔离。两个空间各有成员、邀请、审计日志、通知，
// 在空间 A 的 scoped 下用空间 B 的记录 id 读写，必须拿不到数据或得到 404。
const open = () => createDb(env.HYPERDRIVE)

type Fixture = Awaited<ReturnType<typeof seedWorkspace>>

async function seedWorkspace(db: Database, label: string) {
  const ownerId = newId()
  const otherId = newId()
  const wsId = newId()
  await db.insert(user).values([
    { id: ownerId, name: `${label} owner`, email: `${ownerId}@example.test` },
    { id: otherId, name: `${label} member`, email: `${otherId}@example.test` },
  ])
  await db
    .insert(organization)
    .values({ id: wsId, name: label, slug: `t-${wsId.slice(-12)}`, isPersonal: false })
  const ownerMemberId = newId()
  const otherMemberId = newId()
  await db.insert(member).values([
    { id: ownerMemberId, organizationId: wsId, userId: ownerId, role: 'owner' },
    { id: otherMemberId, organizationId: wsId, userId: otherId, role: 'member' },
  ])
  const invitationId = newId()
  await db.insert(invitation).values({
    id: invitationId,
    organizationId: wsId,
    email: `invitee-${wsId}@example.test`,
    role: 'member',
    inviterId: ownerId,
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  const [audit] = await db
    .insert(auditLog)
    .values({ actorUserId: ownerId, workspaceId: wsId, action: 'member.add' })
    .returning()
  const [note] = await db
    .insert(notification)
    .values({ userId: ownerId, workspaceId: wsId, type: 'test', title: `${label} note` })
    .returning()
  if (!audit || !note) throw new Error('seed failed')
  return {
    wsId,
    ownerId,
    otherId,
    ownerMemberId,
    otherMemberId,
    invitationId,
    auditId: audit.id,
    notificationId: note.id,
  }
}

async function cleanup(db: Database, fixtures: Fixture[]) {
  const userIds = fixtures.flatMap((f) => [f.ownerId, f.otherId])
  const wsIds = fixtures.map((f) => f.wsId)
  await db.delete(notification).where(inArray(notification.userId, userIds))
  // audit_log 对 app 只追加（迁移 0009），审计行由 migrator 清理
  await createDb(env.HYPERDRIVE_MIGRATOR)
    .delete(auditLog)
    .where(inArray(auditLog.actorUserId, userIds))
  await db.delete(invitation).where(inArray(invitation.organizationId, wsIds))
  await db.delete(member).where(inArray(member.organizationId, wsIds))
  await db.delete(organization).where(inArray(organization.id, wsIds))
  await db.delete(user).where(inArray(user.id, userIds))
}

/** 断言抛出的是可映射为 404 的 NOT_FOUND，且错误体不泄露记录信息。 */
async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected NOT_FOUND')
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  expect(toErrorResponse(error)).toEqual({
    status: 404,
    body: { error: { code: NOT_FOUND_CODE, message: 'Not found' } },
  })
}

describe('scoped(db, workspaceId)', () => {
  let a: Fixture
  let b: Fixture

  beforeAll(async () => {
    const db = open()
    a = await seedWorkspace(db, 'A')
    b = await seedWorkspace(db, 'B')
  })

  afterAll(async () => {
    await cleanup(open(), [a, b])
  })

  it('select 只返回本空间的行（四张带空间列的表）', async () => {
    const s = scoped(open(), a.wsId)
    const members = await s.select(member).orderBy(asc(member.id))
    expect(members.map((m) => m.id)).toEqual([a.ownerMemberId, a.otherMemberId].sort())
    expect((await s.select(invitation)).map((i) => i.id)).toEqual([a.invitationId])
    expect((await s.select(auditLog)).map((l) => l.id)).toEqual([a.auditId])
    expect((await s.select(notification)).map((n) => n.id)).toEqual([a.notificationId])
  })

  it('用其他空间的 id 作为查询条件时结果为空', async () => {
    const s = scoped(open(), a.wsId)
    expect(await s.select(member, { where: eq(member.id, b.ownerMemberId) })).toEqual([])
    expect(await s.select(invitation, { where: eq(invitation.id, b.invitationId) })).toEqual([])
    expect(await s.select(auditLog, { where: eq(auditLog.id, b.auditId) })).toEqual([])
    expect(await s.select(notification, { where: eq(notification.id, b.notificationId) })).toEqual(
      [],
    )
    expect(await s.count(member, eq(member.userId, b.ownerId))).toBe(0)
    expect(await s.count(member)).toBe(2)
  })

  it('findById：本空间返回记录，其他空间的 id 与不存在的 id 一样返回 404', async () => {
    const s = scoped(open(), a.wsId)
    expect((await s.findById(member, a.ownerMemberId)).role).toBe('owner')
    expect((await s.findById(notification, a.notificationId)).title).toBe('A note')

    await expectNotFound(s.findById(member, b.ownerMemberId))
    await expectNotFound(s.findById(invitation, b.invitationId))
    await expectNotFound(s.findById(auditLog, b.auditId))
    await expectNotFound(s.findById(notification, b.notificationId))
    await expectNotFound(s.findById(member, newId())) // 不存在
    await expectNotFound(s.findById(member, 'not-a-uuid')) // URL 中的非法 id 不应变成 500
  })

  it('跨空间的 update / delete 不影响对方数据', async () => {
    const db = open()
    const s = scoped(db, a.wsId)

    await expectNotFound(s.updateById(member, b.otherMemberId, { role: 'admin' }))
    await expectNotFound(s.updateById(invitation, b.invitationId, { status: 'canceled' }))
    await expectNotFound(s.deleteById(notification, b.notificationId))

    // 条件式写入：条件命中的是 B 的行，但空间过滤使其影响 0 行
    expect(
      await s.update(member, { role: 'admin' }, eq(member.id, b.otherMemberId)).returning(),
    ).toEqual([])
    expect(await s.delete(invitation, eq(invitation.id, b.invitationId)).returning()).toEqual([])

    const [bMember] = await db.select().from(member).where(eq(member.id, b.otherMemberId))
    expect(bMember?.role).toBe('member')
    const [bInvitation] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, b.invitationId))
    expect(bInvitation?.status).toBe('pending')
    expect(
      await db.select().from(notification).where(eq(notification.id, b.notificationId)),
    ).toHaveLength(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.id, b.auditId))).toHaveLength(1)
  })

  it('本空间的 updateById / deleteById 正常生效', async () => {
    const s = scoped(open(), a.wsId)
    const updated = await s.updateById(member, a.otherMemberId, { role: 'admin' })
    expect(updated).toMatchObject({ id: a.otherMemberId, role: 'admin', organizationId: a.wsId })
    await s.updateById(member, a.otherMemberId, { role: 'member' })

    const extra = await s
      .insert(notification, { userId: a.ownerId, type: 'test', title: 'to delete' })
      .returning()
    const deleted = await s.deleteById(notification, extra[0]?.id ?? '')
    expect(deleted.title).toBe('to delete')
    await expectNotFound(s.findById(notification, deleted.id))
  })

  it('insert 自动填入空间 id；携带其他空间 id 时拒绝写入', async () => {
    const db = open()
    const s = scoped(db, a.wsId)
    const [row] = await s
      .insert(auditLog, { actorUserId: a.ownerId, action: 'scoped.insert' })
      .returning()
    expect(row?.workspaceId).toBe(a.wsId)

    const rows = await s
      .insert(notification, [
        { userId: a.ownerId, type: 'test', title: 'n1' },
        { userId: a.otherId, type: 'test', title: 'n2' },
      ])
      .returning()
    expect(rows.map((r) => r.workspaceId)).toEqual([a.wsId, a.wsId])

    // 类型上已排除空间列；运行时仍校验（例如把请求体整体展开传入）
    const smuggled = { userId: a.ownerId, type: 'test', title: 'smuggled', workspaceId: b.wsId }
    expect(() => s.insert(notification, smuggled)).toThrow(AppError)
    expect(() =>
      s.update(member, { role: 'admin', organizationId: b.wsId } as { role: string }),
    ).toThrow(AppError)
    expect(await db.select().from(notification).where(eq(notification.title, 'smuggled'))).toEqual(
      [],
    )

    // 写入时带上本空间的 id 是允许的
    const own = { actorUserId: a.ownerId, action: 'own', workspaceId: a.wsId }
    expect((await s.insert(auditLog, own).returning())[0]?.workspaceId).toBe(a.wsId)
  })

  it('空间列为空的全局记录不会出现在任何空间中', async () => {
    const db = open()
    const [global] = await db
      .insert(notification)
      .values({ userId: a.ownerId, type: 'test', title: 'global' })
      .returning()
    const s = scoped(db, a.wsId)
    expect(await s.select(notification, { where: eq(notification.title, 'global') })).toEqual([])
    await expectNotFound(s.findById(notification, global?.id ?? ''))
    expect(
      await db
        .select()
        .from(notification)
        .where(and(eq(notification.userId, a.ownerId), isNull(notification.workspaceId))),
    ).toHaveLength(1)
  })

  it('选择部分列并连接非空间表', async () => {
    const s = scoped(open(), a.wsId)
    const rows = await s
      .select(member, { fields: { memberId: member.id, email: user.email, role: member.role } })
      .innerJoin(user, eq(user.id, member.userId))
      .orderBy(asc(member.role))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.role).sort()).toEqual(['member', 'owner'])
    expect(rows.every((r) => r.email.endsWith('@example.test'))).toBe(true)
  })

  it('transaction 内的 scoped 绑定同一空间，抛错时回滚', async () => {
    const db = open()
    const s = scoped(db, a.wsId)
    await expect(
      s.transaction(async (tx) => {
        expect(tx.workspaceId).toBe(a.wsId)
        await tx.insert(auditLog, { actorUserId: a.ownerId, action: 'tx.rollback' })
        await tx.findById(member, b.ownerMemberId) // 跨空间 → NOT_FOUND，整个事务回滚
      }),
    ).rejects.toMatchObject({ code: NOT_FOUND_CODE, status: 404 })
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'tx.rollback'))).toEqual([])

    const count = await s.transaction((tx) => tx.count(invitation))
    expect(count).toBe(1)
  })

  it('不带空间列的表与非法的空间 id 被拒绝', () => {
    const db = open()
    expect(() => scoped(db, 'not-a-uuid')).toThrow()
    const s = scoped(db, a.wsId)
    // @ts-expect-error setting 表没有空间列，类型上不允许
    expect(() => s.select(setting)).toThrow(/workspace/)
    // @ts-expect-error organization 是空间本身，不是空间内的数据
    expect(() => s.select(organization)).toThrow(/workspace/)
  })
})
