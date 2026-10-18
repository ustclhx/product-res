import type { Database } from '@product-res/db'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runSelectionDaily = vi.fn(async (..._args: unknown[]) => [])
const runSelectionLabels = vi.fn(async (..._args: unknown[]) => [])
const runReadinessWeekly = vi.fn(async (..._args: unknown[]) => [])
vi.mock('@product-res/follow', async (original) => ({
  ...(await original<typeof import('@product-res/follow')>()),
  runSelectionDaily: (...args: unknown[]) => runSelectionDaily(...args),
  runSelectionLabels: (...args: unknown[]) => runSelectionLabels(...args),
  runReadinessWeekly: (...args: unknown[]) => runReadinessWeekly(...args),
}))

const { registerNodeSelection } = await import('../src/selection/node.ts')

describe('选品定时任务', () => {
  beforeEach(() => {
    runSelectionDaily.mockClear()
    runSelectionLabels.mockClear()
    runReadinessWeekly.mockClear()
  })

  it('每日流水线 04:00、打标签 05:00、准备度周一 05:30（新加坡时间），错过补跑一次；日期取计划时刻的新加坡日期', async () => {
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
      {
        id: 'selection-label-v1',
        cron: '0 5 * * *',
        timeZone: 'Asia/Singapore',
        missedRun: 'once',
      },
      {
        id: 'selection-readiness-v1',
        cron: '30 5 * * 1',
        timeZone: 'Asia/Singapore',
        missedRun: 'once',
      },
    ])
    // 04:00 SGT = 前一天 20:00 UTC
    await registered[0]?.[1]({ scheduledAt: new Date('2031-04-30T20:00:00Z') })
    expect(runSelectionDaily).toHaveBeenCalledWith(db, { now, asOf: '2031-05-01' })
    await registered[1]?.[1]({ scheduledAt: new Date('2031-04-30T21:00:00Z') })
    expect(runSelectionLabels).toHaveBeenCalledWith(db, { now, today: '2031-05-01' })
    await registered[2]?.[1]({ scheduledAt: new Date('2031-04-27T21:30:00Z') })
    expect(runReadinessWeekly).toHaveBeenCalledWith(db, { now, today: '2031-04-28' })
  })

  it('提供队列与数据层上下文时注册回放队列（串行消费）', () => {
    const scheduler = { register: vi.fn() } as unknown as Scheduler
    const register = vi.fn()
    registerNodeSelection({
      db: {} as Database,
      scheduler,
      queues: { register },
      dataSync: {} as never,
    })
    expect(register).toHaveBeenCalledWith('product-res-selection-replay', expect.any(Function), {
      concurrency: 1,
    })
  })
})
