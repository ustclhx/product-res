import { AppError } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import type { Database } from './client.ts'
import { notification } from './schema/platform.ts'
import { member } from './schema/tenancy.ts'
import { notFound, scoped } from './scoped.ts'

/** 写入和点击均校验；解开编码的结构字符，阻止双斜线、反斜线及控制字符变体。 */
export function notificationLink(link: string | null | undefined) {
  if (link == null) return null
  let decoded = link
  for (;;) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 浏览器会清理控制字符，跳转前必须拒绝。
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded))
      throw new AppError('INVALID_NOTIFICATION_LINK', 'Notification link must be a local path')
    const next = decoded.replace(
      /%(25|2f|5c|0[0-9a-f]|1[0-9a-f]|20|7f)/gi,
      (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)),
    )
    if (next === decoded) return link
    decoded = next
  }
}

/** P4 在任务成功状态提交后调用；接收者必须仍属于该空间。 */
export async function writeNotification(
  db: Database,
  workspaceId: string,
  input: { userId: string; type: string; title: string; body?: string; link?: string },
) {
  const link = notificationLink(input.link)
  const tenant = scoped(db, workspaceId)
  const [recipient] = await tenant
    .select(member, { where: eq(member.userId, input.userId) })
    .limit(1)
  if (!recipient) throw notFound()
  const [created] = await tenant
    .insert(notification, { ...input, link })
    .returning({ id: notification.id })
  return created as { id: string }
}
