import { eq } from 'drizzle-orm'
import type { Database } from './client.ts'
import { setting } from './schema/platform.ts'

/**
 * 全部运行时设置项及其代码默认值，唯一定义处。
 * `setting` 表中缺失某项时使用这里的值，不读取环境变量或模板配置（specs/runtime-config）。
 */
export interface SettingValues {
  /** 是否开放注册 */
  'auth.signupEnabled': boolean
  /** 空字符串表示不显示公告 */
  'site.announcement': string
  'billing.signupBonusDomainBlacklist': string[]
  'operations.telegramBotToken': string
  'operations.telegramChatId': string
  'operations.discordWebhookUrl': string
}

export const settingDefaults: SettingValues = {
  'auth.signupEnabled': true,
  'site.announcement': '',
  'billing.signupBonusDomainBlacklist': [],
  'operations.telegramBotToken': '',
  'operations.telegramChatId': '',
  'operations.discordWebhookUrl': '',
}

export type SettingKey = keyof SettingValues

/** 读取设置的来源：返回表中该项的值，不存在时返回 `undefined`。 */
export interface SettingStore {
  find(key: SettingKey): Promise<unknown>
}

/**
 * 设置缓存，生产中由 KV 实现（`KVNamespace` 结构兼容）。
 * 缓存内容是 JSON 包装：`{"v": 值}` 表示表中存在，`{}` 表示表中缺失，两种结果都缓存。
 */
export interface SettingCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface SettingsContext {
  store: SettingStore
  cache?: SettingCache | undefined
}

/** KV 允许的最小 TTL 为 60 秒；后台修改设置后最多 60 秒生效。 */
export const SETTING_CACHE_TTL_SECONDS = 60

const cacheKey = (key: SettingKey) => `setting:${key}`

export function dbSettingStore(db: Database): SettingStore {
  return {
    async find(key) {
      const rows = await db
        .select({ value: setting.value })
        .from(setting)
        .where(eq(setting.key, key))
        .limit(1)
      return rows[0]?.value
    },
  }
}

export async function getSetting<K extends SettingKey>(
  ctx: SettingsContext,
  key: K,
): Promise<SettingValues[K]> {
  const cached = await ctx.cache?.get(cacheKey(key))
  if (cached != null) {
    return resolve(key, (JSON.parse(cached) as { v?: unknown }).v)
  }
  const value = await ctx.store.find(key)
  await ctx.cache?.put(cacheKey(key), JSON.stringify(value === undefined ? {} : { v: value }), {
    expirationTtl: SETTING_CACHE_TTL_SECONDS,
  })
  return resolve(key, value)
}

function resolve<K extends SettingKey>(key: K, value: unknown): SettingValues[K] {
  return value === undefined ? settingDefaults[key] : (value as SettingValues[K])
}
