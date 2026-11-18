import { eq, sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import { setting } from './schema/platform.ts'

/**
 * 全部运行时设置项及其代码默认值，唯一定义处。
 * `setting` 表中缺失某项时使用这里的值，不读取环境变量或模板配置（specs/runtime-config）。
 */
export interface SettingValues {
  /** 是否开放注册 */
  'auth.signupEnabled': boolean
  'credits.dailyAmount': number
  'credits.dailyMaxDaysPerMonth': number
  'credits.dailyExpiryDays': number
  'credits.dailyRequireVerifiedEmail': boolean
  /** 媒体提交结果不确定时保留预扣、等待已验签回调的秒数；仍受任务 2 小时期限约束（specs/ai-media-tasks）。 */
  'ai.mediaUncertainWaitSeconds': number
  /** 空字符串表示不显示公告 */
  'site.announcement': string
  'billing.signupBonusDomainBlacklist': string[]
  'operations.telegramBotToken': string
  'operations.telegramChatId': string
  'operations.discordWebhookUrl': string
  /**
   * 对话无可见正文失败的免费次数：同一工作区在最近 `windowSeconds` 秒内的前 `count` 次全额退回，
   * 超出后按最后一次上游尝试的用量结算（specs/ai-text-reasoning）。
   */
  'ai.freeFailures': { count: number; windowSeconds: number }
}

export const settingDefaults: SettingValues = {
  'auth.signupEnabled': true,
  'credits.dailyAmount': 10,
  'credits.dailyMaxDaysPerMonth': 10,
  'credits.dailyExpiryDays': 7,
  'credits.dailyRequireVerifiedEmail': true,
  'ai.mediaUncertainWaitSeconds': 3600,
  'site.announcement': '',
  'billing.signupBonusDomainBlacklist': [],
  'operations.telegramBotToken': '',
  'operations.telegramChatId': '',
  'operations.discordWebhookUrl': '',
  'ai.freeFailures': { count: 3, windowSeconds: 3600 },
}

export type SettingKey = keyof SettingValues
export type DailyCreditSettingKey = Extract<SettingKey, `credits.daily${string}`>

/** 数据库/KV 与后台输入共用边界，避免绕过表单后发放非法额度。 */
export function isValidDailyCreditSetting<K extends DailyCreditSettingKey>(
  key: K,
  value: unknown,
): value is SettingValues[K] {
  if (key === 'credits.dailyRequireVerifiedEmail') return typeof value === 'boolean'
  const max =
    key === 'credits.dailyAmount' ? 2147483647 : key === 'credits.dailyMaxDaysPerMonth' ? 31 : 365
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
}

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
        // postgres.js 已解析 JSON，避免 ORM 将字符串标量再次解码成布尔或数字。
        .select({ value: sql<unknown>`${setting.value}` })
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
  const resolved = resolve(key, value)
  await ctx.cache?.put(cacheKey(key), JSON.stringify(value === undefined ? {} : { v: value }), {
    expirationTtl: SETTING_CACHE_TTL_SECONDS,
  })
  return resolved
}

function resolve<K extends SettingKey>(key: K, value: unknown): SettingValues[K] {
  const resolved = value === undefined ? settingDefaults[key] : value
  if (
    key.startsWith('credits.daily') &&
    !isValidDailyCreditSetting(key as DailyCreditSettingKey, resolved)
  ) {
    throw new RangeError(`Invalid runtime setting: ${key}`)
  }
  return resolved as SettingValues[K]
}
