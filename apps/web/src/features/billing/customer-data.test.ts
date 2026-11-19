import {
  getCreditBalance,
  getCreditBatches,
  getCreditLedger,
  getCreditSummary,
} from '@product-res/credits'
import { type Database, scoped } from '@product-res/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creditPageSchema, customerBilling, customerUsage } from './customer-data.ts'

vi.mock('@product-res/credits', () => ({
  getCreditBalance: vi.fn(),
  getCreditSummary: vi.fn(async () => ({
    subscription: { total: 0, currentPeriod: 0 },
    purchase: 12,
    free: { signup: 0, daily: 0, total: 0 },
    other: 0,
    available: 12,
  })),
  getCreditBatches: vi.fn(),
  getCreditLedger: vi.fn(),
}))
vi.mock('@product-res/entitlements', async (original) => ({
  ...(await original<typeof import('@product-res/entitlements')>()),
  getEntitlements: vi.fn(async () => ({ key: 'free' })),
}))
vi.mock('@product-res/db', async (original) => ({
  ...(await original<typeof import('@product-res/db')>()),
  scoped: vi.fn(),
}))
const db = {} as Database
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCreditLedger).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(getCreditBalance).mockResolvedValue({ available: 12, held: 2, debt: 0 })
  vi.mocked(getCreditBatches).mockResolvedValue({ items: [], nextCursor: null })
})
describe('customer data visibility', () => {
  it('filters ordinary member activity by authenticated identity and never reads workspace balance or batches', async () => {
    const page = await customerUsage(
      db,
      'workspace',
      'fresh-user',
      'member',
      { limit: 25 },
      'batches',
    )
    expect(getCreditLedger).toHaveBeenCalledWith(db, 'workspace', {
      limit: 25,
      userId: 'fresh-user',
    })
    expect(getCreditBalance).not.toHaveBeenCalled()
    expect(getCreditBatches).not.toHaveBeenCalled()
    expect(page.balance).toBeNull()
    expect(page.batches).toBeNull()
  })
  it('allows admins to read workspace credit activity', async () => {
    const page = await customerUsage(
      db,
      'workspace',
      'fresh-admin',
      'admin',
      { limit: 25 },
      'ledger',
    )
    expect(getCreditLedger).toHaveBeenCalledWith(db, 'workspace', { limit: 25 })
    expect(page.balance).toEqual({ available: 12, held: 2, debt: 0 })
  })
  it.each(['member', 'admin'])('does not query payment or refund history for %s', async (role) => {
    const select = vi.fn(() => ({
      innerJoin: () => ({
        orderBy: () => Object.assign(Promise.resolve([]), { limit: async () => [] }),
      }),
    }))
    vi.mocked(scoped).mockReturnValue({ select } as unknown as ReturnType<typeof scoped>)
    const page = await customerBilling(db, 'workspace', role, 3)
    expect(select).toHaveBeenCalledTimes(role === 'member' ? 1 : 2)
    expect(page.summary === null).toBe(role === 'member')
    expect(getCreditSummary).toHaveBeenCalledTimes(role === 'member' ? 0 : 1)
    expect(page.payments).toEqual([])
    expect(page.refunds).toEqual([])
  })
  it('bounds history in the database and queries current subscriptions separately', async () => {
    const features = {
      models: [],
      maxConcurrentTasks: 3,
      maxSeats: 1,
      storageGb: 5,
      publicApi: false,
      priorityQueue: false,
      watermark: true,
    }
    const active = {
      id: 'older-active',
      provider: 'stripe',
      planPriceId: 'price',
      name: 'Pro',
      plan: { key: 'pro', sort: 10, features },
      pastDueSince: null,
      status: 'active',
      currentPeriodEnd: new Date('2099-01-01Z'),
      cancelAtPeriodEnd: false,
    }
    const history = Array.from({ length: 50 }, (_, i) => ({
      ...active,
      id: `ended-${i}`,
      status: 'expired',
      currentPeriodEnd: new Date(0),
    }))
    const limit = vi.fn(async () => history)
    const select = vi
      .fn()
      .mockReturnValueOnce({ innerJoin: () => ({ orderBy: () => ({ limit }) }) })
      .mockReturnValueOnce({ innerJoin: () => ({ orderBy: async () => [active] }) })
    vi.mocked(scoped).mockReturnValue({ select } as unknown as ReturnType<typeof scoped>)
    const page = await customerBilling(db, 'workspace', 'admin', 3)
    expect(limit).toHaveBeenCalledWith(50)
    expect(select).toHaveBeenCalledTimes(2)
    expect(select.mock.calls[1]?.[1]).toHaveProperty('where')
    expect(page.subscriptions).toHaveLength(50)
    expect(page.summary?.currentSubscription?.id).toBe('older-active')
    expect(page.summary?.nextRenewalAt).toEqual(active.currentPeriodEnd)
  })

  it('preserves microsecond cursors while bounding page sizes', () => {
    const cursor = {
      createdAt: '2026-10-04T09:00:00.123456Z',
      id: '9e4f8378-149f-440a-bf9b-50c014ecb457',
    }
    expect(creditPageSchema.parse({ limit: 100, cursor }).cursor).toEqual(cursor)
    expect(creditPageSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(creditPageSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(creditPageSchema.safeParse({ cursor: { ...cursor, createdAt: 'bad' } }).success).toBe(
      false,
    )
  })
})
