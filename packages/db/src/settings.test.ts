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
