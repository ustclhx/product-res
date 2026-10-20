import { createRegistry } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import type { ScheduleDefinition, ScheduledHandler, Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ran: string[] = []
vi.mock('@product-res/marketdata', async (original) => ({
  ...(await original<typeof import('@product-res/marketdata')>()),
  expireStaleReservations: async () => {
    ran.push('reconcile')
    return 0
  },
  generateWeeklyAudits: async () => {
    ran.push('accuracy-audit')
    return []
  },
}))
vi.mock('@product-res/follow', async (original) => ({
  ...(await original<typeof import('@product-res/follow')>()),
  runSelectionDaily: async () => {
    ran.push('selection-daily')
    return []
  },
}))

const { registerDataSchedules } = await import('../src/datasources/sync.ts')
const { registerNodeSelection } = await import('../src/selection/node.ts')
const { registerSelectionReview } = await import('../src/review/selection-review.ts')
const { registerNodeStoreTracking } = await import('../src/stores/node.ts')
const { registerAccuracyAudit } = await import('../src/accuracy/weekly-audit.ts')
const { pausePipelineSchedules, PAUSABLE_PIPELINE_SCHEDULES } = await import(
  '../src/pipeline-pause.ts'
)

function fakeScheduler() {
  const registered = new Map<string, ScheduledHandler>()
  const health = vi.fn(async () => ({ healthy: true }))
  const scheduler = {
    register: (definition: ScheduleDefinition, handler: ScheduledHandler) => {
      registered.set(definition.id, handler)
    },
    health,
  } as unknown as Scheduler
  return { scheduler, registered, health }
}

function registerAll(scheduler: Scheduler) {
  const db = {} as Database
  registerDataSchedules(scheduler, { db, registry: createRegistry([]), secret: () => undefined })
  registerNodeSelection({ db, scheduler })
  registerSelectionReview(scheduler, db)
  registerNodeStoreTracking({
    scheduler,
    queues: { register: () => {} },
    dataSync: { db, registry: createRegistry([]), secret: () => undefined },
  })
  registerAccuracyAudit(scheduler, db)
}

afterEach(() => {
  ran.length = 0
  vi.restoreAllMocks()
})

describe('DATA_PIPELINE_SCHEDULES 暂停开关', () => {
  it('暂停时计划仍注册，到点只记录 pipeline.paused；对账计划照常运行', async () => {
    const { scheduler, registered, health } = fakeScheduler()
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const paused = pausePipelineSchedules(scheduler, true)
    registerAll(paused)

    expect([...registered.keys()].sort()).toEqual(
      [...PAUSABLE_PIPELINE_SCHEDULES, 'datasources-reconcile-v1'].sort(),
    )
    const scheduledAt = new Date('2031-06-01T20:00:00Z')
    for (const id of PAUSABLE_PIPELINE_SCHEDULES) {
      await registered.get(id)?.({ scheduledAt })
      expect(info).toHaveBeenCalledWith('pipeline.paused', { scheduleId: id })
    }
    expect(ran).toEqual([])
    await registered.get('datasources-reconcile-v1')?.({ scheduledAt })
    expect(ran).toEqual(['reconcile'])
    await paused.health()
    expect(health).toHaveBeenCalledOnce()
  })

  it('未暂停时返回原调度器，处理函数按原逻辑执行', async () => {
    const { scheduler, registered } = fakeScheduler()
    expect(pausePipelineSchedules(scheduler, false)).toBe(scheduler)
    vi.spyOn(log, 'info').mockImplementation(() => {})
    registerAll(scheduler)
    await registered.get('selection-daily-v1')?.({ scheduledAt: new Date('2031-06-01T20:00:00Z') })
    expect(ran).toEqual(['selection-daily'])
  })
})
