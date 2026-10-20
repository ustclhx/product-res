import type { Database } from '@product-res/db'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls: Date[] = []
vi.mock('@product-res/marketdata', async (original) => ({
  ...(await original<typeof import('@product-res/marketdata')>()),
  generateWeeklyAudits: async (_db: unknown, now: Date) => {
    calls.push(now)
    return [
      { workspaceId: 'a', created: true },
      { workspaceId: 'b', created: false, error: new Error('boom') },
    ]
  },
}))

const { ACCURACY_AUDIT_SCHEDULE, registerAccuracyAudit } = await import(
  '../src/accuracy/weekly-audit.ts'
)
const { PAUSABLE_PIPELINE_SCHEDULES } = await import('../src/pipeline-pause.ts')

afterEach(() => {
  calls.length = 0
  vi.restoreAllMocks()
})

describe('每周人工抽检计划', () => {
  it('周一 06:00 新加坡时间运行，属于可暂停的数据流水线', () => {
    expect(ACCURACY_AUDIT_SCHEDULE).toMatchObject({
      id: 'accuracy-audit-weekly-v1',
      cron: '0 6 * * 1',
      timeZone: 'Asia/Singapore',
      missedRun: 'once',
    })
    expect(PAUSABLE_PIPELINE_SCHEDULES.has(ACCURACY_AUDIT_SCHEDULE.id)).toBe(true)
  })

  it('按计划触发时刻生成；单个空间失败记录错误，不影响其他空间', async () => {
    const handlers = new Map<string, ScheduledHandler>()
    const scheduler = {
      register: (d: ScheduleDefinition, h: ScheduledHandler) => handlers.set(d.id, h),
      health: async () => ({ healthy: true }),
    } as unknown as Scheduler
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    registerAccuracyAudit(scheduler, {} as Database)
    const scheduledAt = new Date('2031-03-02T22:00:00Z')
    await handlers.get('accuracy-audit-weekly-v1')?.({ scheduledAt })
    expect(calls).toEqual([scheduledAt])
    expect(error).toHaveBeenCalledWith(
      'accuracy_audit.generate_failed',
      expect.objectContaining({ workspaceId: 'b' }),
    )
    expect(info).toHaveBeenCalledWith('accuracy_audit.done', {
      workspaces: 2,
      created: 1,
      failed: 1,
    })
  })
})
