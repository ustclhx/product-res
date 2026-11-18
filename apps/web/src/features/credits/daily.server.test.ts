import { grantDailyCredits } from '@product-res/credits'
import type { Database } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDailyCredits } from './daily.server.ts'

vi.mock('@product-res/credits', () => ({ grantDailyCredits: vi.fn() }))
vi.mock('@product-res/shared/log', () => ({ log: { warn: vi.fn() } }))

const db = {} as Database
const user = { id: 'user', emailVerified: false }
const now = new Date('2026-11-10T08:00:00.000Z')
const granted = {
  status: 'granted' as const,
  grantId: 'grant',
  credits: 10,
  daysThisMonth: 1,
  maxDaysPerMonth: 10,
  expiresAt: '2026-11-17T08:00:00.000Z',
  day: '2026-11-10',
}

function fixture() {
  const values = new Map<string, string>()
  const cache = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(),
  }
  const input = { db, cache: cache as KeyValueStore, user, session: {}, enabled: true, now }
  return { cache, input }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(grantDailyCredits).mockResolvedValue(granted)
})

describe('daily App checks', () => {
  it('skips all daily database and cache work when disabled or impersonating', async () => {
    const { cache, input } = fixture()
    expect(await checkDailyCredits({ ...input, enabled: false })).toEqual({ status: 'disabled' })
    expect(await checkDailyCredits({ ...input, session: { impersonatedBy: 'admin' } })).toEqual({
      status: 'disabled',
    })
    expect(cache.get).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
    expect(grantDailyCredits).not.toHaveBeenCalled()
  })

  it.each(['granted', 'already_claimed', 'monthly_limit'] as const)(
    'caches %s until the next UTC midnight without replaying the grant notice',
    async (status) => {
      const { cache, input } = fixture()
      const result = status === 'granted' ? granted : { status }
      vi.mocked(grantDailyCredits).mockResolvedValueOnce(result)
      expect(await checkDailyCredits(input)).toEqual(result)
      expect(await checkDailyCredits(input)).toEqual({ status: 'cached' })
      expect(grantDailyCredits).toHaveBeenCalledTimes(1)
      expect(cache.put).toHaveBeenCalledWith('daily-credits:user:2026-11-10:false', 'checked', {
        expirationTtl: 16 * 60 * 60,
      })
    },
  )

  it('keeps the cache TTL at least 60 seconds near UTC midnight', async () => {
    const { cache, input } = fixture()
    await checkDailyCredits({ ...input, now: new Date('2026-11-10T23:59:59Z') })
    expect(cache.put).toHaveBeenCalledWith(expect.any(String), 'checked', { expirationTtl: 60 })
  })

  it.each(['unverified', 'blacklisted'] as const)('caches %s for 300 seconds', async (status) => {
    const { cache, input } = fixture()
    vi.mocked(grantDailyCredits).mockResolvedValueOnce({ status })
    expect(await checkDailyCredits(input)).toEqual({ status })
    expect(cache.put).toHaveBeenCalledWith(
      expect.any(String),
      status === 'unverified' ? 'unverified' : 'checked',
      { expirationTtl: 300 },
    )
  })

  it.each(['ACCOUNT_UNAVAILABLE', 'PERSONAL_WORKSPACE_REQUIRED'])(
    'caches business rejection %s for 300 seconds and logs its code',
    async (code) => {
      const { cache, input } = fixture()
      vi.mocked(grantDailyCredits).mockRejectedValueOnce(new AppError(code, 'Not eligible'))
      expect(await checkDailyCredits(input)).toEqual({ status: 'ineligible' })
      expect(await checkDailyCredits(input)).toEqual({ status: 'cached' })
      expect(grantDailyCredits).toHaveBeenCalledTimes(1)
      expect(cache.put).toHaveBeenCalledWith(expect.any(String), 'checked', { expirationTtl: 300 })
      expect(log.warn).toHaveBeenCalledWith('credits.daily.ineligible', { userId: user.id, code })
    },
  )

  it('retains the verification entry on cache hits and retries immediately after verification', async () => {
    const { input } = fixture()
    vi.mocked(grantDailyCredits).mockResolvedValueOnce({ status: 'unverified' })
    expect(await checkDailyCredits(input)).toEqual({ status: 'unverified' })
    expect(await checkDailyCredits(input)).toEqual({ status: 'unverified' })
    expect(grantDailyCredits).toHaveBeenCalledTimes(1)
    expect(await checkDailyCredits({ ...input, user: { ...user, emailVerified: true } })).toEqual(
      granted,
    )
    expect(grantDailyCredits).toHaveBeenCalledTimes(2)
  })

  it('isolates cache entries by user and UTC day', async () => {
    const { input } = fixture()
    await checkDailyCredits(input)
    await checkDailyCredits({ ...input, user: { ...user, id: 'other' } })
    await checkDailyCredits({ ...input, now: new Date('2026-11-11T00:00:00Z') })
    expect(grantDailyCredits).toHaveBeenCalledTimes(3)
  })

  it('continues through the database when KV is unavailable', async () => {
    const { cache, input } = fixture()
    cache.get.mockRejectedValueOnce(new Error('KV unavailable'))
    cache.put.mockRejectedValueOnce(new Error('KV unavailable'))
    expect(await checkDailyCredits(input)).toEqual(granted)
    expect(log.warn).toHaveBeenCalledWith('credits.daily.cache_read_failed', { userId: user.id })
    expect(log.warn).toHaveBeenCalledWith('credits.daily.cache_write_failed', { userId: user.id })
  })

  it('isolates database failures from App loading and leaves the next visit able to retry', async () => {
    const { cache, input } = fixture()
    vi.mocked(grantDailyCredits).mockRejectedValueOnce(new Error('DB unavailable'))
    expect(await checkDailyCredits(input)).toBeNull()
    expect(cache.put).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('credits.daily.check_failed', { userId: user.id })
    expect(await checkDailyCredits(input)).toEqual(granted)
  })
})
