import { env } from 'cloudflare:workers'
import { createDb, member, notification, organization, scoped, user } from '@product-res/db'
import { newId } from '@product-res/shared'
import { inArray } from 'drizzle-orm'
import { expect, it } from 'vitest'
import {
  listNotifications,
  markNotificationsRead,
  writeNotification,
} from '../src/features/notifications/service.ts'

it('通知按空间和接收者隔离，单条与全部已读不影响其他用户或空间', async () => {
  const db = createDb(env.HYPERDRIVE)
  const users = [newId(), newId()]
  const spaces = [newId(), newId()]
  const first = users[0] as string
  const second = users[1] as string
  const space = spaces[0] as string
  const other = spaces[1] as string
  try {
    await db
      .insert(user)
      .values(users.map((id) => ({ id, name: 'Notification test', email: `${id}@notify.test` })))
    await db.insert(organization).values(
      spaces.map((id) => ({
        id,
        name: 'Notify test',
        slug: `notify-${id}`,
        createdAt: new Date(),
      })),
    )
    await scoped(db, space).insert(member, [
      { id: newId(), userId: first, role: 'owner' },
      { id: newId(), userId: second, role: 'member' },
    ])
    await scoped(db, other).insert(member, { id: newId(), userId: first, role: 'owner' })
    await expect(
      writeNotification(db, other, { userId: second, type: 'test', title: 'Non-member' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const own = await writeNotification(db, space, {
      userId: first,
      type: 'task.completed',
      title: 'Done',
      link: '/app',
    })
    const theirs = await writeNotification(db, space, {
      userId: second,
      type: 'test',
      title: 'Private',
    })
    const elsewhere = await writeNotification(db, other, {
      userId: first,
      type: 'test',
      title: 'Other space',
    })
    expect((await listNotifications(db, space, first)).rows.map((row) => row.id)).toEqual([own.id])
    expect(await markNotificationsRead(db, space, first, theirs.id)).toEqual({
      updated: 0,
      link: null,
    })
    expect(await markNotificationsRead(db, space, first, elsewhere.id)).toEqual({
      updated: 0,
      link: null,
    })
    await markNotificationsRead(db, space, first, own.id)
    expect((await listNotifications(db, space, first)).unread).toBe(0)
    await writeNotification(db, space, { userId: first, type: 'test', title: 'Next' })
    await markNotificationsRead(db, space, first)
    expect((await listNotifications(db, space, first)).unread).toBe(0)
    expect((await listNotifications(db, space, second)).unread).toBe(1)
    expect((await listNotifications(db, other, first)).unread).toBe(1)
    const [legacy] = await scoped(db, space)
      .insert(notification, {
        userId: first,
        type: 'legacy',
        title: 'Unsafe legacy link',
        link: '/%2Fevil.test',
      })
      .returning({ id: notification.id })
    await expect(markNotificationsRead(db, space, first, legacy?.id)).rejects.toMatchObject({
      code: 'INVALID_NOTIFICATION_LINK',
    })
    await expect(
      writeNotification(db, space, {
        userId: first,
        type: 'test',
        title: 'Bad',
        link: '//evil.test',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_NOTIFICATION_LINK' })
  } finally {
    for (const id of spaces) {
      await scoped(db, id).delete(notification, undefined)
      await scoped(db, id).delete(member, undefined)
    }
    await db.delete(organization).where(inArray(organization.id, spaces))
    await db.delete(user).where(inArray(user.id, users))
  }
})
