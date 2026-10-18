import { AppError } from '@product-res/shared'
import type {
  QueueHealth,
  ScheduleDefinition,
  ScheduledHandler,
  Scheduler,
  SchedulerHealth,
  TaskHealth,
} from '../index.ts'

/** CF cron 由 Wrangler 部署，注册只能映射原有 UTC triggers，不能动态创造时区调度。 */
export function createCloudflareScheduler(options: {
  crons: readonly string[]
  health: () => Promise<SchedulerHealth>
}): Scheduler & {
  scheduled(controller: Pick<ScheduledController, 'cron' | 'scheduledTime'>): Promise<void>
} {
  const registered = new Map<
    string,
    { definition: ScheduleDefinition; handler: ScheduledHandler }
  >()
  return {
    register(definition, handler) {
      if (
        definition.timeZone !== 'UTC' ||
        definition.missedRun !== 'skip' ||
        !options.crons.includes(definition.cron)
      )
        throw new AppError(
          'SCHEDULE_UNSUPPORTED',
          'Cloudflare requires deployed UTC cron triggers',
          { status: 503 },
        )
      if (registered.has(definition.id))
        throw new AppError('SCHEDULE_EXISTS', 'Schedule id already registered', { status: 409 })
      registered.set(definition.id, { definition, handler })
    },
    health: options.health,
    async scheduled(controller) {
      const handlers = [...registered.values()].filter(
        ({ definition }) => definition.cron === controller.cron,
      )
      if (!handlers.length)
        throw new AppError('SCHEDULE_NOT_FOUND', 'Unknown cron', { status: 404 })
      const results = await Promise.allSettled(
        handlers.map(({ handler }) =>
          Promise.resolve().then(() =>
            handler({ scheduledAt: new Date(controller.scheduledTime) }),
          ),
        ),
      )
      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Scheduled tasks failed',
        )
    },
  }
}

/** 没有原生 queue ping：composition root 明确提供探测，不能用 DB 可达代替 queue 正常。 */
export function createCloudflareTaskHealth(probes: {
  queue: () => Promise<QueueHealth>
  scheduler: Scheduler
}): TaskHealth {
  return { queue: probes.queue, scheduler: () => probes.scheduler.health() }
}
