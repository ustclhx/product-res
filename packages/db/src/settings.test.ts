import { describe, expect, it } from 'vitest'
import {
  getSetting,
  SETTING_CACHE_TTL_SECONDS,
  type SettingCache,
  type SettingKey,
  type SettingStore,
  settingDefaults,
} from './settings.ts'

function memoryStore(rows: Partial<Record<SettingKey, unknown>>) {
  const calls: SettingKey[] = []
  const store: SettingStore = {
    async find(key) {
      calls.push(key)
      return rows[key]
    },
  }
  return { store, calls }
}

function memoryCache() {
  const data = new Map<string, string>()
  const ttls: (number | undefined)[] = []
  const cache: SettingCache = {
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value, options) {
      data.set(key, value)
      ttls.push(options?.expirationTtl)
    },
  }
  return { cache, data, ttls }
}

describe('getSetting', () => {
  it('表中存在时返回表中的值', async () => {
    const { store } = memoryStore({ 'auth.signupEnabled': false })
    expect(await getSetting({ store }, 'auth.signupEnabled')).toBe(false)
  })

  it('表中缺失时回退到代码默认值', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'auth.signupEnabled')).toBe(
      settingDefaults['auth.signupEnabled'],
    )
    expect(settingDefaults['auth.signupEnabled']).toBe(true)
  })

  it('媒体不确定提交默认等待 1 小时', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'ai.mediaUncertainWaitSeconds')).toBe(3600)
  })

  it('表中存在时写入缓存，之后命中缓存不再查表', async () => {
    const { store, calls } = memoryStore({ 'auth.signupEnabled': false })
    const { cache, data, ttls } = memoryCache()
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(false)
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(false)
    expect(calls).toEqual(['auth.signupEnabled'])
    expect(data.get('setting:auth.signupEnabled')).toBe('{"v":false}')
    expect(ttls).toEqual([SETTING_CACHE_TTL_SECONDS])
  })

  it('表中缺失的结果也缓存，命中时仍回退到默认值', async () => {
    const { store, calls } = memoryStore({})
    const { cache, data } = memoryCache()
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(true)
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(true)
    expect(calls).toEqual(['auth.signupEnabled'])
    expect(data.get('setting:auth.signupEnabled')).toBe('{}')
  })
})

describe('ai.freeFailures', () => {
  it('默认每小时 3 次免费失败', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'ai.freeFailures')).toEqual({
      count: 3,
      windowSeconds: 3600,
    })
  })

  it('表中保存的值覆盖默认值', async () => {
    const { store } = memoryStore({ 'ai.freeFailures': { count: 0, windowSeconds: 600 } })
    expect(await getSetting({ store }, 'ai.freeFailures')).toEqual({ count: 0, windowSeconds: 600 })
  })
})

describe('每日赠送设置读取边界', () => {
  it('缺失时使用数量、月天数、有效期及邮箱验证默认值', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'credits.dailyAmount')).toBe(10)
    expect(await getSetting({ store }, 'credits.dailyMaxDaysPerMonth')).toBe(10)
    expect(await getSetting({ store }, 'credits.dailyExpiryDays')).toBe(7)
    expect(await getSetting({ store }, 'credits.dailyRequireVerifiedEmail')).toBe(true)
  })

  it('接受合法上界与显式关闭邮箱验证', async () => {
    const { store } = memoryStore({
      'credits.dailyAmount': 2147483647,
      'credits.dailyMaxDaysPerMonth': 31,
      'credits.dailyExpiryDays': 365,
      'credits.dailyRequireVerifiedEmail': false,
    })
    for (const key of [
      'credits.dailyAmount',
      'credits.dailyMaxDaysPerMonth',
      'credits.dailyExpiryDays',
      'credits.dailyRequireVerifiedEmail',
    ] as const) {
      expect(await getSetting({ store }, key)).toEqual(await store.find(key))
    }
  })

  it.each([
    ['credits.dailyAmount', 0],
    ['credits.dailyAmount', 2147483648],
    ['credits.dailyAmount', 1.5],
    ['credits.dailyAmount', '10'],
    ['credits.dailyMaxDaysPerMonth', 32],
    ['credits.dailyExpiryDays', 366],
    ['credits.dailyRequireVerifiedEmail', 'false'],
  ] as const)('拒绝数据库与缓存中的非法设置 %s=%s', async (key, value) => {
    const { store } = memoryStore({ [key]: value })
    await expect(getSetting({ store }, key)).rejects.toThrow(RangeError)
    const { cache, data } = memoryCache()
    data.set(`setting:${key}`, JSON.stringify({ v: value }))
    await expect(getSetting({ store: memoryStore({}).store, cache }, key)).rejects.toThrow(
      RangeError,
    )
  })
})
