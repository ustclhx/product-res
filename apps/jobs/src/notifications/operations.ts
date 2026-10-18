// biome-ignore-all lint/plugin: 运营通知在后台跨空间消费，只访问系统审计标记与设置。
import { auditLog, type Database, dbSettingStore, getSetting } from '@product-res/db'
import { and, eq } from 'drizzle-orm'

export interface OperationsEvent {
  event: 'payment.succeeded' | 'refund.requested' | 'webhook.failed' | 'reconciliation.failed'
  sourceId: string
  workspaceId?: string
  amount?: number
  currency?: string
}
export interface OperationsQueueMessage {
  v: 1
  operations: OperationsEvent[]
  requestId?: string
}

const events = new Set([
  'payment.succeeded',
  'refund.requested',
  'webhook.failed',
  'reconciliation.failed',
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 附加字段是可选的，旧版 billing 消息仍由原消费者处理。 */
export function parseOperationsMessage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    input.v !== 1 ||
    !Array.isArray(input.operations) ||
    !input.operations.length ||
    input.operations.length > 20
  )
    return null
  const operations: OperationsEvent[] = []
  for (const entry of input.operations) {
    if (!entry || typeof entry !== 'object') return null
    const e = entry as Record<string, unknown>
    if (
      typeof e.event !== 'string' ||
      !events.has(e.event) ||
      typeof e.sourceId !== 'string' ||
      !/^[\w:.-]{1,256}$/.test(e.sourceId) ||
      (e.workspaceId !== undefined &&
        (typeof e.workspaceId !== 'string' || !uuid.test(e.workspaceId))) ||
      (e.amount !== undefined && (!Number.isSafeInteger(e.amount) || (e.amount as number) < 0)) ||
      (e.currency !== undefined &&
        (typeof e.currency !== 'string' || !/^[A-Za-z]{3}$/.test(e.currency)))
    )
      return null
    operations.push({
      event: e.event as OperationsEvent['event'],
      sourceId: e.sourceId,
      ...(e.workspaceId === undefined ? {} : { workspaceId: e.workspaceId as string }),
      ...(e.amount === undefined ? {} : { amount: e.amount as number }),
      ...(e.currency === undefined ? {} : { currency: e.currency as string }),
    })
  }
  const requestId =
    typeof input.requestId === 'string' && /^[\w-]{1,64}$/.test(input.requestId)
      ? input.requestId
      : undefined
  return { operations, requestId }
}

export interface OperationsChannels {
  telegramBotToken: string
  telegramChatId: string
  discordWebhookUrl: string
}
export async function readOperationsChannels(db: Database): Promise<OperationsChannels> {
  // 密钥不写 KV，只有发送端持有明文。
  const ctx = { store: dbSettingStore(db) }
  const [telegramBotToken, telegramChatId, discordWebhookUrl] = await Promise.all([
    getSetting(ctx, 'operations.telegramBotToken'),
    getSetting(ctx, 'operations.telegramChatId'),
    getSetting(ctx, 'operations.discordWebhookUrl'),
  ])
  // 与后台读取一致，保留数字形式 chat ID 的字符串契约。
  return { telegramBotToken, telegramChatId: String(telegramChatId), discordWebhookUrl }
}
const labels = {
  'payment.succeeded': 'New payment',
  'refund.requested': 'New refund request',
  'webhook.failed': 'Webhook processing failed',
  'reconciliation.failed': 'Reconciliation failed',
}

/** 网络异常只暴露渠道和状态；异常文本可能带含 token 的请求 URL，不能透传。 */
export async function sendOperationsChannel(
  channel: 'telegram' | 'discord',
  channels: OperationsChannels,
  event: OperationsEvent,
  timeoutMs = 5000,
) {
  const text = [
    labels[event.event],
    `Reference: ${event.sourceId}`,
    ...(event.workspaceId ? [`Workspace: ${event.workspaceId}`] : []),
    ...(event.amount !== undefined
      ? [`Amount: ${event.amount} ${event.currency ?? ''} (minor units)`]
      : []),
  ].join('\n')
  const url =
    channel === 'telegram'
      ? `https://api.telegram.org/bot${channels.telegramBotToken}/sendMessage`
      : `${channels.discordWebhookUrl}?wait=true`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      // workerd 不支持 redirect: 'error'；manual 下 3xx 由 !response.ok 视为失败。
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        channel === 'telegram'
          ? { chat_id: channels.telegramChatId, text }
          : { content: text, allowed_mentions: { parse: [] } },
      ),
    })
    if (!response.ok) throw new Error('HTTP failure')
    if (channel === 'telegram' && !((await response.json()) as { ok?: boolean }).ok)
      throw new Error('API failure')
  } catch {
    throw new Error(`Operations ${channel} delivery failed`)
  } finally {
    clearTimeout(timer)
  }
}

/** 各渠道分别记录成功，重试只重发尚未成功的渠道；最终失败由现有 max_retries 策略丢弃，最后一次失败仍有结构化日志。 */
export async function deliverOperations(db: Database, event: OperationsEvent) {
  const channels = await readOperationsChannels(db)
  for (const channel of ['telegram', 'discord'] as const) {
    if (
      channel === 'telegram'
        ? !(channels.telegramBotToken && channels.telegramChatId)
        : !channels.discordWebhookUrl
    )
      continue
    const action = `operations.sent.${channel}`
    const targetId = `${event.event}:${event.sourceId}`
    const [sent] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
      .limit(1)
    if (sent) continue
    await sendOperationsChannel(channel, channels, event)
    await db.insert(auditLog).values({
      action,
      targetType: 'operations_event',
      targetId,
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    })
  }
}
