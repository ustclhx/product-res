import { getCreditBalance, getCreditBatches, getCreditLedger } from '@product-res/credits'
import { type Database, scoped } from '@product-res/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creditPageSchema, customerBilling, customerUsage } from './customer-data.ts'

vi.mock('@product-res/credits', () => ({
  getCreditBalance: vi.fn(),
  getCreditBatches: vi.fn(),
  getCreditLedger: vi.fn(),
}))
vi.mock('@product-res/entitlements', () => ({
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
      innerJoin: () => ({ orderBy: () => ({ limit: async () => [] }) }),
    }))
    vi.mocked(scoped).mockReturnValue({ select } as unknown as ReturnType<typeof scoped>)
    const page = await customerBilling(db, 'workspace', role, 3)
    expect(select).toHaveBeenCalledTimes(1)
    expect(page.payments).toEqual([])
    expect(page.refunds).toEqual([])
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
