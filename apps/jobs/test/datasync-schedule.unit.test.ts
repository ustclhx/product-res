import { createRegistry } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
const dispatch = vi.fn(async (..._args: unknown[]) => {
  calls.push('dispatch')
})
vi.mock('../src/datasources/plan.ts', async (original) => ({
  ...(await original<typeof import('../src/datasources/plan.ts')>()),
  dispatchDailyCollections: (...args: unknown[]) => dispatch(...args),
}))
vi.mock('@product-res/marketdata', async (original) => ({
  ...(await original<typeof import('@product-res/marketdata')>()),
  createDbArchive: () => ({ purgeExpired: async () => 0 }),
  expireStaleReservations: async () => 0,
  runQualityChecks: async () => {
    calls.push('quality')
    return 0
  },
}))

const { registerDataSchedules } = await import('../src/datasources/sync.ts')

describe('数据层每日流水线', () => {
  const registered: [ScheduleDefinition, ScheduledHandler][] = []
  const scheduler = {
    register: (definition: ScheduleDefinition, handler: ScheduledHandler) => {
      registered.push([definition, handler])
    },
  } as unknown as Scheduler
  const context = { db: {} as Database, registry: createRegistry([]), secret: () => undefined }
  registerDataSchedules(scheduler, context)
  const daily = registered.find(([d]) => d.id === 'datasources-daily-v1')

  beforeEach(() => {
    calls.length = 0
    dispatch.mockClear()
  })

  it('02:00 新加坡时间、停机只补一次；先投递采集再做质量检查', async () => {
    expect(daily?.[0]).toEqual({
      id: 'datasources-daily-v1',
      cron: '0 2 * * *',
      timeZone: 'Asia/Singapore',
      missedRun: 'once',
    })
    const scheduledAt = new Date('2031-06-01T18:00:00Z')
    await daily?.[1]({ scheduledAt })
    expect(dispatch).toHaveBeenCalledWith(context, scheduledAt)
    expect(calls).toEqual(['dispatch', 'quality'])
  })

  it('投递失败不阻止维护，本次运行记为失败', async () => {
    dispatch.mockRejectedValueOnce(new Error('db down'))
    await expect(daily?.[1]({ scheduledAt: new Date() })).rejects.toThrow('db down')
    expect(calls).toEqual(['quality'])
  })
})
