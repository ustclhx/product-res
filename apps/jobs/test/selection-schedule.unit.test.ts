import type { Database } from '@product-res/db'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runSelectionDaily = vi.fn(async (..._args: unknown[]) => [])
vi.mock('@product-res/follow', async (original) => ({
  ...(await original<typeof import('@product-res/follow')>()),
  runSelectionDaily: (...args: unknown[]) => runSelectionDaily(...args),
}))

const { registerNodeSelection } = await import('../src/selection/node.ts')

describe('selection-daily-v1', () => {
  beforeEach(() => runSelectionDaily.mockClear())

  it('每天 04:00 新加坡时间运行，错过补跑一次；计算日取计划时刻的新加坡日期', async () => {
    const registered: [ScheduleDefinition, ScheduledHandler][] = []
    const scheduler = {
      register: (definition: ScheduleDefinition, handler: ScheduledHandler) => {
        registered.push([definition, handler])
      },
    } as unknown as Scheduler
    const now = new Date('2031-05-01T00:00:00Z')
    const db = {} as Database
    registerNodeSelection({ db, scheduler, now: () => now })
    expect(registered.map(([d]) => d)).toEqual([
      {
        id: 'selection-daily-v1',
        cron: '0 4 * * *',
        timeZone: 'Asia/Singapore',
        missedRun: 'once',
      },
    ])
    // 04:00 SGT = 前一天 20:00 UTC
    await registered[0]?.[1]({ scheduledAt: new Date('2031-04-30T20:00:00Z') })
    expect(runSelectionDaily).toHaveBeenCalledWith(db, { now, asOf: '2031-05-01' })
  })
})
