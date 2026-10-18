import { type Database, notification, notificationLink, scoped } from '@product-res/db'
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'

const NOTIFICATION_PAGE_SIZE = 50

export { notificationLink, writeNotification } from '@product-res/db'

export async function listNotifications(
  db: Database,
  workspaceId: string,
  userId: string,
  offset = 0,
) {
  const tenant = scoped(db, workspaceId)
  const recipient = eq(notification.userId, userId)
  const [rows, unread] = await Promise.all([
    tenant
      .select(notification, { where: recipient })
      .orderBy(desc(notification.id))
      .limit(NOTIFICATION_PAGE_SIZE + 1)
      .offset(offset),
    tenant.count(notification, and(recipient, isNull(notification.readAt))),
  ])
  return {
    rows: rows.slice(0, NOTIFICATION_PAGE_SIZE),
    unread,
    hasMore: rows.length > NOTIFICATION_PAGE_SIZE,
  }
}

export async function markNotificationsRead(
  db: Database,
  workspaceId: string,
  userId: string,
  id?: string,
) {
  const tenant = scoped(db, workspaceId)
  let link: string | null = null
  if (id !== undefined) {
    const [row] = await tenant
      .select(notification, {
        where: and(eq(notification.id, id), eq(notification.userId, userId)) as SQL,
      })
      .limit(1)
    // 点击时重新读取并校验数据库中的目标，不信任客户端传入或旧列表中的链接。
    link = notificationLink(row?.link)
  }
  const rows = await tenant
    .update(
      notification,
      { readAt: new Date() },
      and(
        eq(notification.userId, userId),
        isNull(notification.readAt),
        id === undefined ? undefined : eq(notification.id, id),
      ),
    )
    .returning({ id: notification.id })
  return { updated: rows.length, link }
}
