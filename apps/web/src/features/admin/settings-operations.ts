import {
  type Database,
  dbSettingStore,
  getSetting,
  type SettingKey,
  setting,
  settingDefaults,
} from '@product-res/db'
import { redact } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminActionScope } from './action.ts'

export const OPERATIONS_SETTING_KEYS = [
  'operations.telegramBotToken',
  'operations.telegramChatId',
  'operations.discordWebhookUrl',
] as const satisfies readonly SettingKey[]

// 远程地址限制在服务商域名，后台输入不成为 SSRF 出口。
export const operationsSettingsInput = z.object({
  telegramBotToken: z
    .string()
    .regex(/^\d+:[A-Za-z0-9_-]{20,200}$/)
    .nullable()
    .optional(),
  telegramChatId: z
    .string()
    .trim()
    .max(100)
    .refine((v) => v === '' || /^-?\d+$|^@[A-Za-z0-9_]+$/.test(v)),
  discordWebhookUrl: z
    .url()
    .refine((v) => {
      const url = new URL(v)
      return (
        url.protocol === 'https:' &&
        ['discord.com', 'discordapp.com'].includes(url.hostname) &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
      )
    })
    .nullable()
    .optional(),
})

export async function readOperationsSettings(db: Database) {
  const ctx = { store: dbSettingStore(db) }
  const [token, telegramChatId, webhook] = await Promise.all([
    getSetting(ctx, 'operations.telegramBotToken'),
    getSetting(ctx, 'operations.telegramChatId'),
    getSetting(ctx, 'operations.discordWebhookUrl'),
  ])
  // jsonb 驱动可能把数字形式的字符串再次解析成 number；chat ID 的对外契约仍为字符串。
  return {
    telegramConfigured: Boolean(token),
    telegramChatId: String(telegramChatId),
    discordConfigured: Boolean(webhook),
  }
}

export async function writeOperationsSettings(
  { tx, audit }: AdminActionScope,
  input: z.infer<typeof operationsSettingsInput>,
) {
  const values = {
    'operations.telegramBotToken': input.telegramBotToken,
    'operations.telegramChatId': input.telegramChatId,
    'operations.discordWebhookUrl': input.discordWebhookUrl,
  }
  for (const key of OPERATIONS_SETTING_KEYS) {
    if (values[key] === undefined) continue // 空表单保留已配置密钥；null 显式清除。
    const value = values[key] ?? ''
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`setting:${key}`}, 0))`)
    const [before] = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, key))
      .for('update')
    await tx
      .insert(setting)
      .values({ key, value })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    await audit({
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      meta: {
        key,
        changes: redact({
          [key]: { oldValue: before?.value ?? settingDefaults[key], newValue: value },
        }),
      },
    })
  }
}
