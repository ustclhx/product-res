import { defineTemplateConfig } from '@product-res/config'
import { auditLog, dbSettingStore, getSetting, setting, user } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { runAdminAction } from '../src/features/admin/action.ts'
import {
  invalidateRuntimeSettings,
  RUNTIME_SETTING_KEYS,
  readRuntimeSettings,
  writeRuntimeSettings,
} from '../src/features/admin/settings.ts'
import { runtimeSettingsInput } from '../src/features/admin/settings-schema.ts'
import { assertSignupAdmission } from '../src/features/growth/service.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

it('保存设置后清除旧 KV 值，拒绝未受邀注册，并审计每项的新旧值', async () => {
  const db = createAdminTestDb()
  const admin = { id: newId() }
  const original = await db
    .select()
    .from(setting)
    .where(inArray(setting.key, [...RUNTIME_SETTING_KEYS]))
  const cached = new Map<string, string>()
  const cache = {
    get: async (key: string) => cached.get(key) ?? null,
    put: async (key: string, value: string) => {
      cached.set(key, value)
    },
    delete: async (key: string) => {
      cached.delete(key)
    },
  }
  const ctx = { store: dbSettingStore(db), cache }
  try {
    await db.insert(user).values({
      ...admin,
      name: 'Settings admin',
      email: `${admin.id}@settings.test`,
      role: 'admin',
    })
    // 缓存已预热，数据库写入不能直接改变它。
    await db
      .insert(setting)
      .values({ key: 'auth.signupEnabled', value: true })
      .onConflictDoUpdate({ target: setting.key, set: { value: true } })
    const before = await readRuntimeSettings(db)
    for (const key of RUNTIME_SETTING_KEYS) await getSetting(ctx, key)
    const input = runtimeSettingsInput.parse({
      signupEnabled: false,
      announcement: ' Scheduled maintenance ',
      signupBonusDomainBlacklist: [' Mailinator.com. ', 'mailinator.com', 'temp-mail.test'],
    })
    await runAdminAction({ db, admin, ip: '203.0.113.14' }, 'setting.update', (scope) =>
      writeRuntimeSettings(scope, input),
    )
    expect(await getSetting(ctx, 'auth.signupEnabled')).toBe(true)
    await invalidateRuntimeSettings(cache)
    expect(await getSetting(ctx, 'auth.signupEnabled')).toBe(false)
    expect(await getSetting(ctx, 'site.announcement')).toBe('Scheduled maintenance')
    expect(await getSetting(ctx, 'billing.signupBonusDomainBlacklist')).toEqual([
      'mailinator.com',
      'temp-mail.test',
    ])
    await expect(
      assertSignupAdmission(
        {
          db,
          config: defineTemplateConfig({
            app: { name: 'Test', url: 'http://localhost:3000', supportEmail: 'help@example.test' },
          }),
          secret: 'test-secret',
        },
        'guest@example.test',
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: 'SIGNUP_DISABLED', status: 403 })
    const records = await db.select().from(auditLog).where(eq(auditLog.actorUserId, admin.id))
    expect(records).toHaveLength(3)
    const oldValues = [before.signupEnabled, before.announcement, before.signupBonusDomainBlacklist]
    const newValues = [input.signupEnabled, input.announcement, input.signupBonusDomainBlacklist]
    for (const [index, key] of RUNTIME_SETTING_KEYS.entries()) {
      expect(records.find((row) => row.targetId === key)).toMatchObject({
        action: 'setting.updated',
        targetType: 'setting',
        ip: '203.0.113.14',
        meta: { key, oldValue: oldValues[index], newValue: newValues[index] },
      })
    }
  } finally {
    await db.delete(setting).where(inArray(setting.key, [...RUNTIME_SETTING_KEYS]))
    if (original.length) await db.insert(setting).values(original)
    await createAdminTestDb('migrator').delete(auditLog).where(eq(auditLog.actorUserId, admin.id))
    await db.delete(user).where(eq(user.id, admin.id))
  }
})

it('邮箱域黑名单拒绝 URL 和邮箱地址，避免误保存无效规则', () => {
  for (const domain of ['https://mailinator.com', 'user@mailinator.com', 'bad_domain.test']) {
    expect(
      runtimeSettingsInput.safeParse({
        signupEnabled: true,
        announcement: '',
        signupBonusDomainBlacklist: [domain],
      }).success,
    ).toBe(false)
  }
})
