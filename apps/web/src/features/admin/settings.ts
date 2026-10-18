import {
  type Database,
  dbSettingStore,
  getSetting,
  type SettingKey,
  type SettingValues,
  setting,
  settingDefaults,
} from '@product-res/db'
import { eq, sql } from 'drizzle-orm'
import type { AdminActionScope } from './action.ts'
import type { RuntimeSettingsInput } from './settings-schema.ts'

export const RUNTIME_SETTING_KEYS = [
  'auth.signupEnabled',
  'site.announcement',
  'billing.signupBonusDomainBlacklist',
] as const satisfies readonly SettingKey[]

export async function readRuntimeSettings(db: Database) {
  // 后台表单直接读事实来源，避免用旧缓存覆盖刚保存的设置。
  const ctx = { store: dbSettingStore(db) }
  const [signupEnabled, announcement, signupBonusDomainBlacklist] = await Promise.all([
    getSetting(ctx, 'auth.signupEnabled'),
    getSetting(ctx, 'site.announcement'),
    getSetting(ctx, 'billing.signupBonusDomainBlacklist'),
  ])
  return { signupEnabled, announcement, signupBonusDomainBlacklist }
}

/** 业务写入与前后值审计同事务；锁覆盖缺失行，首次保存也不会丢失并发修改的旧值。 */
export async function writeRuntimeSettings(
  { tx, audit }: AdminActionScope,
  input: RuntimeSettingsInput,
) {
  const values: Pick<SettingValues, (typeof RUNTIME_SETTING_KEYS)[number]> = {
    'auth.signupEnabled': input.signupEnabled,
    'site.announcement': input.announcement,
    'billing.signupBonusDomainBlacklist': input.signupBonusDomainBlacklist,
  }
  for (const key of RUNTIME_SETTING_KEYS) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`setting:${key}`}, 0))`)
    const [before] = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, key))
      .for('update')
    const value = values[key]
    await tx
      .insert(setting)
      .values({ key, value })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    await audit({
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      meta: { key, oldValue: before?.value ?? settingDefaults[key], newValue: value },
    })
  }
}

/** 只在事务提交后删除；失败时保留已提交值并向调用方报告，KV TTL 仍限制陈旧时间。 */
export async function invalidateRuntimeSettings(cache: { delete(key: string): Promise<void> }) {
  await Promise.all(RUNTIME_SETTING_KEYS.map((key) => cache.delete(`setting:${key}`)))
}
